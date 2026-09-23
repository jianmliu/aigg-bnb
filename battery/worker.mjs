// Dedicated battery coordinator. Own BNB pays operational gas; job contracts hold all execution fees.
import fs from 'node:fs';import path from 'node:path';import http from 'node:http';import {fileURLToPath} from 'node:url';
import {parseAbiItem,keccak256,toHex} from 'viem';
import {synchronousInbox,readFinalized,assignmentReady,verifyDeployment,normalizeSession,sessionOutcome,sessionExpired,acceptedSession,SynchronousMarketAbi} from '../relayer/synchronous.mjs';
import {clients} from '../relayer/chain.mjs';import {BatteryQueue,atomic,stringify} from './queue.mjs';
import {state0Root} from '../gateway/state0.mjs';import {batteryBatch,resolvedRuns,rowOf} from '../flybnb/battery/battery_batch.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const porw=f=>import(path.join(root,'contracts/lib/aigg-porw/web/porw-browser',f));
const V=await porw('verify.js'),B=await porw('batch.js'),L=await porw('lif.js');
const {PorwNode}=await porw('node.js'),{loadKernelFromBytes}=await porw('porw.js'),{RelayClient}=await porw('relay_client.js'),{keypair}=await porw('claim.js');
const abi=name=>JSON.parse(fs.readFileSync(path.join(root,`contracts/out/${name}.sol/${name}.json`))).abi;
const need=k=>{if(!process.env[k])throw Error(`${k} required`);return process.env[k];};
const dep=JSON.parse(fs.readFileSync(need('BATTERY_DEPLOYMENT'))),factory=need('BATTERY_BUDGET'),ch=clients(dep,need('BATTERY_KEY'));
if(['synchronous-vrf-v1','synchronous-vrf-rounds-v1'].includes(dep.verification?.mode))throw Error('Battery budgets do not yet escrow VRF admission fees; VRF battery posting is disabled');
const SYNCHRONOUS=await verifyDeployment(dep,()=>ch.market.read.protocolVersion(),()=>ch.market.read.admissionVersion());
const raw=fs.readFileSync(need('BATTERY_SPEC')),spec=JSON.parse(raw),versionHash=keccak256(raw),batch=batteryBatch(spec),runs=resolvedRuns(batch);
const dirs=path.resolve(need('BATTERY_STATE')),models=path.resolve(need('BATTERY_MODELS'));
const tokenMode=process.env.BATTERY_ASSET_MODE==='token';
if(process.env.BATTERY_ASSET_MODE&&!['native','token'].includes(process.env.BATTERY_ASSET_MODE))throw Error('invalid BATTERY_ASSET_MODE');
const factoryAbi=abi(tokenMode?'TokenBatteryBudget':'BatteryBudget'),jobAbi=abi(tokenMode?'TokenBatteryJob':'BatteryJob'),collectionAbi=abi('FlyCollection'),marketAbi=[...abi(tokenMode?'MultiAssetTaskMarket':'TaskMarket'),...SynchronousMarketAbi];
const rd=(address,abi,functionName,args=[])=>ch.pub.readContract({address,abi,functionName,args});
const tx=async(address,abi,functionName,args=[])=>{const {request}=await ch.pub.simulateContract({address,abi,functionName,args,account:ch.account});const hash=await ch.wallet.writeContract(request);const r=await ch.pub.waitForTransactionReceipt({hash});if(r.status!=='success')throw Error(`${functionName} reverted`);return r;};
const policy=await rd(factory,factoryAbi,'policy'),collection=await rd(factory,factoryAbi,'collection');
const paymentToken=tokenMode?await rd(factory,factoryAbi,'paymentToken'):'0x'+'0'.repeat(40);
if(Number(await ch.pub.getChainId())!==Number(dep.chainId))throw Error('RPC chain mismatch');
if((await rd(factory,factoryAbi,'market')).toLowerCase()!==dep.addresses.market.toLowerCase())throw Error('market mismatch');
if((await rd(factory,factoryAbi,'operator')).toLowerCase()!==ch.account.address.toLowerCase())throw Error('wrong operator');
const runsRoot=V.hex(V.merkleRoot(runs.map((r,k)=>B.runLeaf(k,r.stimulusSeed,state0Root(spec.neurons,r.stimulusSeed,[...r.stimulusIds]).root))));
if(policy[0]!==versionHash||policy[1]!==runsRoot||Number(policy[2])!==runs.length||Number(policy[3])!==spec.steps||Number(policy[4])!==spec.commit_stride)throw Error('battery file does not match locked policy');
if(spec.steps%2!==0||!Array.isArray(spec.readout?.neuron_index))throw Error('battery requires even steps and readout neurons');
fs.mkdirSync(dirs,{recursive:true});
// Recover a dead local process lock; an active PID requires operator intervention, never concurrent writers.
const lockPath=path.join(dirs,'worker.lock');
if(fs.existsSync(lockPath)){
 const pid=Number(fs.readFileSync(lockPath,'utf8'));if(!Number.isSafeInteger(pid)||pid<=0)throw Error('invalid worker lock');
 try{process.kill(pid,0);throw Error('battery worker already running');}catch(e){if(e.code!=='ESRCH')throw e;fs.unlinkSync(lockPath);}
}
const lock=fs.openSync(lockPath,'wx',0o600);fs.writeFileSync(lock,String(process.pid));fs.closeSync(lock);
process.on('exit',()=>{if(fs.existsSync(lockPath)&&fs.readFileSync(lockPath,'utf8')===String(process.pid))fs.unlinkSync(lockPath);});
const relay=new RelayClient([need('BATTERY_RELAY')],keypair(process.env.BATTERY_KEY));await relay.connect();
let verifiedModel=null;
const entries=new Map(); const ZERO='0x'+'0'.repeat(64);const artifactDir=path.join(dirs,'artifacts');
async function sessions(wallet,taskId){if(SYNCHRONOUS)return synchronousInbox(ch,wallet,taskId);const head=await ch.pub.getBlockNumber({cacheTime:0});const event=parseAbiItem('event SessionKeySet(address indexed instance, address indexed session, uint64 expiry)');
 let logs=[];const start=BigInt(process.env.BATTERY_REGISTRY_FROM_BLOCK||0);
 for(let from=start;from<=head;from+=2000n)logs.push(...await ch.pub.getLogs({address:dep.addresses.instances,event,args:{instance:wallet},fromBlock:from,toBlock:from+1999n>head?head:from+1999n}));
 for(const l of logs.reverse())if(l.args.expiry>head&&(await ch.instances.read.resolve([l.args.session])).toLowerCase()===wallet.toLowerCase())return l.args.session;
 throw Error(`no live session for ${wallet}`);
}
async function disputeResolved(tid){try{return await rd(dep.addresses.market,[parseAbiItem('function disputeResolved(bytes32) view returns (bool)')],'disputeResolved',[tid]);}catch{return false;}}
const announcements=new Map();
const adapter={
 async jobs(){const out=[];const n=Number(await rd(collection,collectionAbi,'totalSupply'));for(let id=1;id<=n;id++){const job=await rd(factory,factoryAbi,'jobOf',[BigInt(id)]);if(BigInt(job)){out.push(job.toLowerCase());entries.set(job.toLowerCase(),id);}}return out;},
 async observe(job){
  const observeAt=async(options,block)=>{
   const rd=(address,abi,functionName,args=[])=>ch.pub.readContract({address,abi,functionName,args,...options});
   const tokenId=entries.get(job),ind=await rd(collection,collectionAbi,'individuals',[BigInt(tokenId)]),tid=await rd(job,jobAbi,'taskId');
   const closed=await rd(job,jobAbi,'closed'),hash=await rd(job,jobAbi,'artifactHash');
   const state={paymentToken,tokenId,mepId:ind[3],modelId:ind[2],modelReady:ind[3]!==ZERO,taskId:tid,hasTask:tid!==ZERO,closed,delivered:hash!==ZERO,artifactHash:hash,
    expired:block.timestamp>=await rd(job,jobAbi,'expiresAt'),exhausted:await rd(job,jobAbi,'attempt')>=BigInt(policy[6])};
   if(state.hasTask){const t=await rd(dep.addresses.market,marketAbi,'tasks',[tid]);state.postedAt=String(t[3]);
    if(SYNCHRONOUS){const session=normalizeSession(await ch.market.read.sessionState([tid],options)),outcome=sessionOutcome(session);Object.assign(state,{verification:session,settled:outcome.terminal,disputed:false,repudiated:t[8],final:outcome.terminal,accepted:outcome.accepted,inconclusive:outcome.status==='inconclusive',finalizedBlock:String(block.number),finalizedHash:block.hash});}
    else Object.assign(state,{settled:t[6],disputed:t[7]&&!await disputeResolved(tid),repudiated:t[8],final:await rd(job,jobAbi,'settledFinal'),accepted:await rd(job,jobAbi,'accepted')});
   }return state;
  };
  return SYNCHRONOUS?readFinalized(ch.pub,observeAt):observeAt({},await ch.pub.getBlock());
 },
 async validate(job,s){const file=path.join(models,s.modelId+'.bin');if(!fs.existsSync(file)){const e=Error(`Missing reconstructed payload ${s.modelId}.bin`);e.code='MODEL_DATA_MISSING';throw e;}
 const m=await ch.meps.read.getMEP([s.mepId]);if(Number(m.neurons)!==spec.neurons)throw Error('battery neuron layout mismatch');
 if(verifiedModel?.mepId===s.mepId)return;
 const w=Number(await ch.meps.read.lifWeightUnit([m.execKind]));if(!w)throw Error('unsupported execution kind');
 const node=new PorwNode(await loadKernelFromBytes(fs.readFileSync(path.join(root,'contracts/lib/aigg-porw/web/porw-browser/sketch.wasm'))));
 const st=await node.loadModel(s.modelId,new Uint8Array(fs.readFileSync(file)),{exec:'lif',maxSteps:spec.steps,wUnitQ16:w});
 if(V.hex(st.mep.modelId)!==s.modelId||V.hex(st.mep.execKind)!==m.execKind||V.hex(st.csr.synapseRoot)!==m.synapseRoot||st.hdr.synapses!==Number(m.synapses))throw Error('payload does not match registered profile');
 verifiedModel={mepId:s.mepId,node,st};
 },
 async capacity(job,s){const epoch=await ch.claims.read.currentEpoch();const votes=await ch.instances.read.eligibleVotes([s.mepId,epoch]);
 const unique=[...new Set(votes.map(x=>x.toLowerCase()))];let accepting=0;
 for(const who of unique)if((!SYNCHRONOUS||await ch.market.read.ready([who]))&&(!tokenMode||await rd(dep.addresses.market,marketAbi,'acceptedToken',[who,paymentToken])))accepting++;
 return BigInt(await ch.claims.read.beacon([epoch]))!==0n&&accepting>=Number(policy[5]);},
 async post(job){await tx(job,jobAbi,'post',[await ch.pub.getBlockNumber({cacheTime:0})+(SYNCHRONOUS?await ch.market.read.TASK_TIMEOUT()+20n:BigInt(process.env.BATTERY_TASK_BLOCKS||400))]);},
 async execute(job,s){
 if(SYNCHRONOUS){
  const session=normalizeSession(await ch.market.read.sessionState([s.taskId]));
  const [head,finalized]=await Promise.all([ch.pub.getBlockNumber({cacheTime:0}),ch.pub.getBlock({blockTag:'finalized'})]);
  if(assignmentReady(session,head,finalized.number,s.postedAt)!=='ready')return;
  const executors=await ch.market.read.executors([s.taskId]);
  // Start both inbox requests without blocking expiry polling on a silent peer.
  for(const who of executors){const key=s.taskId+who;if(announcements.has(key))continue;
   const request=(async()=>{try{await relay.request(await sessions(who,s.taskId),'batch-announce',s.mepId,{...batch,taskId:s.taskId,initStateRoot:runsRoot},{timeoutMs:Number(process.env.BATTERY_RESULT_TIMEOUT_MS||600000),responseType:'result'});}catch(e){atomic(path.join(dirs,job+'.execution.json'),{taskId:s.taskId,executor:who,error:e.message});}finally{announcements.delete(key);}})();
   announcements.set(key,request);
  }return;
 }
 const ex=await ch.market.read.executors([s.taskId]);for(const who of ex){if(await ch.market.read.submitted([s.taskId,who]))continue;
 try{const got=await relay.request(await sessions(who,s.taskId),'batch-announce',s.mepId,{...batch,taskId:s.taskId,initStateRoot:runsRoot},{timeoutMs:Number(process.env.BATTERY_RESULT_TIMEOUT_MS||600000),responseType:'result'});
 const p=got.payload;
 if(!await ch.market.read.submitted([s.taskId,who]))await tx(dep.addresses.market,marketAbi,'submitResult',[s.taskId,{execDigest:p.execDigest,execRoot:p.execRoot},p.signature]);
 }catch(e){atomic(path.join(dirs,job+'.execution.json'),{taskId:s.taskId,executor:who,error:e.message});}}
 },
 async settle(job,s){
 if(SYNCHRONOUS){const session=normalizeSession(await ch.market.read.sessionState([s.taskId]));if(sessionExpired(session,await ch.pub.getBlockNumber({cacheTime:0})))await tx(dep.addresses.market,marketAbi,'expire',[s.taskId]);return;}
 const st=await rd(dep.addresses.market,marketAbi,'tasks',[s.taskId]);if(st[6]||st[7])return;
 const ex=await ch.market.read.executors([s.taskId]);let count=0;for(const who of ex)if(await ch.market.read.submitted([s.taskId,who]))count++;
 if(count===ex.length||await ch.pub.getBlockNumber({cacheTime:0})>st[3]+await ch.market.read.TASK_TIMEOUT())await tx(dep.addresses.market,marketAbi,'settle',[s.taskId]);},
 async archive(job,s){
 const accepted=SYNCHRONOUS?await readFinalized(ch.pub,options=>acceptedSession(ch.market,s.taskId,options)):null;
 const ref=accepted?null:await ch.market.read.settledRef([s.taskId]);const settledRoot=accepted?accepted.execRoot:(await ch.market.read.resultOf([s.taskId,ref]))[1];
 const {node,st}=verifiedModel;
 const rows=[],leaves=[];
 for(let k=0;k<runs.length;k++){const r=await node.execute(st.mep.mepId,{steps:spec.steps,commitStride:spec.commit_stride,...runs[k]});
 leaves.push(B.runResultLeaf(k,r.result.execRoot));
 const mid=await node.lifStates(st.mep.mepId,spec.steps/2),late=spec.readout.neuron_index.map(i=>r.result.counts[i]-L.decodeState(mid,i*16).count);
 if(late.some(x=>x<0))throw Error('invalid late readout');
 rows.push({...rowOf(spec,k),execRoot:V.hex(r.result.execRoot),countsDigest:V.hex(r.result.execDigest),descending_spikes_late:late.reduce((a,b)=>a+b,0),descending_counts_late:late,
 spikes:Array.from(r.result.counts).reduce((a,b)=>a+b,0),neurons_reached:Array.from(r.result.counts).filter(x=>x>0).length});}
 if(V.hex(V.merkleRoot(leaves))!==settledRoot)throw Error('independent battery replay disagrees with settled execution');
 if(accepted&&V.hex(B.batchDigest(V.unhex(settledRoot))).toLowerCase()!==accepted.execDigest.toLowerCase())throw Error('accepted batch digest does not bind the independently replayed output');
 const result={paymentToken,chainId:dep.chainId,collection,tokenId:s.tokenId,job,taskId:s.taskId,mepId:s.mepId,modelId:s.modelId,batteryVersion:versionHash,settledRoot,verification:SYNCHRONOUS?'independent-replay-and-synchronous-completion':'independent-replay-and-final-settlement',rarityStatus:'reference-cohort-required',rows};
 if(SYNCHRONOUS){const final=await readFinalized(ch.pub,options=>acceptedSession(ch.market,s.taskId,options));if(final.execRoot!==accepted.execRoot||final.execDigest!==accepted.execDigest)throw Error('accepted result changed during independent replay');}
 atomic(path.join(artifactDir,job+'.json'),result);return keccak256(toHex(stringify(result)));
 },
 async deliver(job,s,hash){await tx(job,jobAbi,'deliver',[hash]);}
};
const queue=new BatteryQueue(adapter,dirs);
const server=http.createServer((req,res)=>{const m=/^\/(artifacts\/)?(0x[0-9a-f]{40})\.json$/.exec(req.url);res.setHeader('Access-Control-Allow-Origin','*');if(!m){res.writeHead(404);return res.end();}const file=path.join(m[1]?artifactDir:dirs,m[2]+'.json');if(!fs.existsSync(file)){res.writeHead(404);return res.end();}res.setHeader('Content-Type','application/json');res.end(fs.readFileSync(file));});
server.listen(Number(process.env.BATTERY_PORT||8792),process.env.BATTERY_HOST||'127.0.0.1');
let stop=false;for(const sig of ['SIGINT','SIGTERM'])process.on(sig,()=>{stop=true;relay.close();server.close();});
try{while(!stop){await queue.tick();await new Promise(r=>setTimeout(r,Number(process.env.BATTERY_POLL_MS||3000)));}}finally{fs.unlinkSync(path.join(dirs,'worker.lock'));}
