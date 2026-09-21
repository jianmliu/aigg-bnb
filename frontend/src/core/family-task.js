import { createPublicClient, http, parseAbi, hexToString, keccak256 } from 'viem';
const ZERO32 = '0x' + '00'.repeat(32), ZERO = '0x' + '00'.repeat(20);
const word = /^0x[\da-f]{64}$/i;
const abi = parseAbi([
 'struct Task { bytes32 mepId; uint32 stimulusSeed; uint32 steps; uint32 commitStride; bytes32 initStateRoot; uint256 fee; uint64 deadline; uint8 redundancy; }',
 'struct MEP { bytes32 modelId; bytes32 schemeDigest; bytes32 execKind; uint32 neurons; uint32 synapses; bytes32 synapseRoot; bytes weightsDA; }',
 'function tasks(bytes32) view returns (Task,address,uint64,uint64,uint64,bool,bool,bool,bool)',
 'function executors(bytes32) view returns (address[])', 'function submitted(bytes32,address) view returns (bool)',
 'function batchRuns(bytes32) view returns (uint32)', 'function TASK_TIMEOUT() view returns (uint64)',
 'function enrollmentMep(bytes32) view returns (bytes32)', 'function baseOf(bytes32) view returns (bytes32)',
 'function getMEP(bytes32) view returns (MEP)', 'function termsOf(bytes32) view returns (address,uint16)',
 'function lifWeightUnit(bytes32) view returns (uint32)',
]);
const same = (a,b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
const assert = (yes, msg) => { if (!yes) throw Error(msg); };
const uint = x => Number.isSafeInteger(x) && x >= 0 && x <= 0xffffffff;

export function recipeSources(da, { sp = '', mirrors = [] } = {}) {
 let urls;
 if (da.startsWith('gnfd://')) {
   const object = da.slice(7); urls = [...mirrors.slice(0,8).map(m => `${m.replace(/\/$/,'')}/${object}`), ...(sp ? [`${sp.replace(/\/$/,'')}/view/${object}`] : [])];
 } else urls = [da];
 return urls.filter(u => { try { return /^https?:$/.test(new URL(u).protocol); } catch { return false; } });
}
async function boundedBytes(url, fetcher, maxBytes, signal) {
 const response = await fetcher(url, { credentials:'omit', signal:AbortSignal.any([signal, AbortSignal.timeout(15000)]) });
 if (!response.ok) throw Error(`recipe HTTP ${response.status}`);
 if (Number(response.headers.get('content-length')) > maxBytes) { await response.body?.cancel(); throw Error('recipe exceeds size limit'); }
 const reader = response.body?.getReader(); assert(reader, 'recipe has no response body');
 const chunks=[]; let size=0;
 try { while(true) { const {value,done}=await reader.read();if(done)break;size+=value.length;assert(size<=maxBytes,'recipe exceeds size limit');chunks.push(value); } }
 finally { await reader.cancel(); }
 const bytes=new Uint8Array(size);let at=0;for(const chunk of chunks){bytes.set(chunk,at);at+=chunk.length;}return bytes;
}
export async function recipeGraph(urls, base, { fetcher=fetch, runtime, maxRecipes=8, maxDepth=8, maxBytes=65536, signal=AbortSignal.timeout(45000) }={}) {
 runtime ||= await import('/porw/delta.js');
 const ancestors = new Map(), active = new Set(); let total = 0;
 const load = async (sources, expected, depth) => {
   signal.throwIfAborted();
   assert(depth<=maxDepth,'recipe ancestry is too deep');
   if(expected && ancestors.has(expected))return ancestors.get(expected);
   assert(!expected || !active.has(expected),'cyclic recipe ancestry');
   assert(ancestors.size+active.size<maxRecipes,'too many ancestor recipes');
   if(expected)active.add(expected);
   let bytes,d,last;
   for(const url of sources)try {
     signal.throwIfAborted();
     bytes=await boundedBytes(url,fetcher,maxBytes,signal);
     assert(!expected || keccak256(bytes)===expected,'ancestor recipe hash mismatch');
     assert(runtime.isDelta3(bytes),'family hosting requires FLYDELTAv3');d=runtime.decodeDelta3(bytes);
     assert(d.layout===1 && d.ops.length===0,'family recipe must use in-place layout without explicit edits');
     assert(same('0x'+Array.from(d.baseModelId,x=>x.toString(16).padStart(2,'0')).join(''),base.modelId),'recipe base mismatch');
     assert(d.neurons===base.neurons,'recipe neuron count mismatch');
     if(base.nameBytes!==undefined)assert(new TextEncoder().encode(d.name).length===base.nameBytes,'recipe name length mismatch');
     break;
   } catch(e) { signal.throwIfAborted();last=e;bytes=null; }
   assert(bytes,last?.message || 'no recipe source available');
   total+=bytes.length;assert(total<=maxBytes*maxRecipes,'recipe graph too large');
   for(const pid of [d.parentA,d.parentB]) {
     const id='0x'+Array.from(pid,x=>x.toString(16).padStart(2,'0')).join('');if(id===ZERO32)continue;
     await load(urls.map(u=>new URL(id+'.delta',u).href),id,depth+1);
   }
   if(expected){active.delete(expected);ancestors.set(expected,bytes);}return bytes;
 };
 const delta=await load(urls,null,0);
 return {delta:delta.buffer,ancestors:[...ancestors].map(([id,bytes])=>({id,bytes:bytes.buffer}))};
}

// A task is read directly from the running node's configured chain, never trusted from relay payloads.
export function createFamilyResolver({ deployment, instance, families, sp='', client, fetcher=fetch, runtime }) {
 client ||= createPublicClient({transport:http(deployment.rpc,{retryCount:1,timeout:15000})});
 let verifiedChain=false, busy=false;
 return async env => {
   assert(!busy,"family resolver is busy");busy=true;
   const signal=AbortSignal.timeout(45000);
   try {
   const p=env?.payload;assert(p && word.test(p.taskId) && word.test(env.mepId),'invalid task announcement');
   assert(['task-announce','batch-announce'].includes(env.type),'unsupported task announcement');
   assert(JSON.stringify(p).length<=1048576,'task announcement too large');
   if(!verifiedChain){assert(await client.getChainId()===Number(deployment.chainId),'RPC chain mismatch');verifiedChain=true;}
   const blockNumber=await client.getBlockNumber({cacheTime:0});
   const read=(address,functionName,args=[])=>client.readContract({address,abi,functionName,args,blockNumber});
   const market=deployment.addresses.market;
   const [stored,executors,submitted,runs,timeout]=await Promise.all([
     read(market,'tasks',[p.taskId]),read(market,'executors',[p.taskId]),read(market,'submitted',[p.taskId,instance]),read(market,'batchRuns',[p.taskId]),read(market,'TASK_TIMEOUT'),
   ]);
   const [task,,,postedAt,,exists,settled,disputed]=stored;
   assert(exists && !settled && !disputed && !submitted,'task is not open for execution');
   assert(blockNumber<=postedAt+timeout,'task execution lease expired');
   assert(executors.some(x=>same(x,instance)),'host was not assigned this task');
   assert(same(task.mepId,env.mepId),'task MEP mismatch');
   for(const key of ['steps','commitStride','stimulusSeed'])assert(p[key]===undefined || (uint(p[key]) && Number(task[key])===p[key]),'task '+key+' mismatch');
   assert(p.initStateRoot===undefined || same(p.initStateRoot,task.initStateRoot),'task initial state mismatch');
   const batch=Number(runs)>0;assert(batch===(env.type==='batch-announce'),'task batch kind mismatch');
   if(batch)assert(Array.isArray(p.runs) && p.runs.length===Number(runs) && Number(runs)<=64,'task batch count mismatch');
   const [pool,base,m,terms]=await Promise.all([
     read(deployment.addresses.instances,'enrollmentMep',[task.mepId]),read(deployment.addresses.meps,'baseOf',[task.mepId]),
     read(deployment.addresses.meps,'getMEP',[task.mepId]),read(deployment.addresses.meps,'termsOf',[task.mepId]),
   ]);
   const baseMepId=pool.toLowerCase(),family=families.get(baseMepId);
   assert(family,'task is outside the hosted model families');
   assert(same(base,ZERO32)?same(pool,task.mepId):same(pool,base),'task enrollment routing mismatch');
   assert(Number(task.steps)<=family.maxSteps,'task exceeds host step capacity');
   const unit=Number(await read(deployment.addresses.meps,'lifWeightUnit',[m.execKind]));
   const checkIds=ids=>{if(ids===undefined)return;assert(Array.isArray(ids)&&ids.length<=Number(m.neurons)&&ids.every(x=>uint(x)&&x<Number(m.neurons)),'invalid stimulus/silence ids');};
   checkIds(p.stimulusIds);checkIds(p.silenceIds);
   for(const ids of Object.values(p.sets||{}))checkIds(ids);
   for(const run of p.runs||[]){assert(run && uint(run.stimulusSeed),'invalid batch seed');checkIds(run.stimulusIds);checkIds(run.silenceIds);}
   const mep={mepId:task.mepId.toLowerCase(),modelId:m.modelId.toLowerCase(),baseMepId:same(base,ZERO32)?null:base.toLowerCase(),enrollmentMepId:baseMepId,
     exec:unit?'int-lif':'int-spmv-q16',wUnitQ16:unit,beneficiary:same(terms[0],ZERO)?null:terms[0],royaltyBps:Number(terms[1]),neurons:Number(m.neurons),synapses:Number(m.synapses),synapseRoot:m.synapseRoot};
   const payload={...p,steps:Number(task.steps),commitStride:Number(task.commitStride),stimulusSeed:Number(task.stimulusSeed),initStateRoot:task.initStateRoot};
   const graph=mep.baseMepId?await recipeGraph(recipeSources(hexToString(m.weightsDA),{sp,mirrors:deployment.brainMirrors}),family,{fetcher,runtime,signal}):{delta:null,ancestors:[]};
   return {taskId:p.taskId.toLowerCase(),baseMepId,mep,payload,...graph};
   } finally { busy=false; }
 };
}
