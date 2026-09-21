#!/usr/bin/env node
/** Bounded two-host smoke worker. No deployment, task purchase, withdrawal or cleanup.
 * Dry-run: node js/smoke_synchronous_testnet.mjs --relayer=https://... --gateway=https://... 
 *   --journal=/private/outside-repo/smoke.bin --payload=/path/base.bin --mep=0x... --max-steps=4
 * Live, after review: same arguments --broadcast (SMOKE_OWNER_KEY in environment).
 * Runs until BOTH hosts have one confirmed drained terminal session. Root must separately
 * issue exactly one paid gateway request after the public READY log and perform cleanup.
 * The journal contains secret keys, salts and signed messages; never upload or commit it.
 */
import fs from 'node:fs';import path from 'node:path';import vm from 'node:vm';
import {serialize,deserialize} from 'node:v8';import {fileURLToPath,pathToFileURL} from 'node:url';
import {parseArgs} from 'node:util';import {generatePrivateKey,privateKeyToAccount} from 'viem/accounts';
import {parseAbi,parseEther,formatEther} from 'viem';import {clients} from '../relayer/chain.mjs';
import {SynchronousHost} from '../frontend/src/core/synchronous-host.js';
import {createFamilyResolver} from '../frontend/src/core/family-task.js';
const ROOT=fileURLToPath(new URL('../',import.meta.url));
const GAS_ALLOWANCE=parseEther('0.001'),CAP=parseEther('0.02');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
export function validateDeployment(dep){
 if(Number(dep.chainId)!==97)throw Error('smoke requires chain 97');
 if(dep.verification?.mode!=='synchronous-v1')throw Error('synchronous deployment required');
 if(!dep.addresses?.market||!dep.addresses?.instances||!dep.rpc)throw Error('incomplete deployment');
}
export function fundingPlan(unit,balances,spent=0n){
 const plan=balances.map(b=>unit+GAS_ALLOWANCE>b?unit+GAS_ALLOWANCE-b:0n);
 if(plan.reduce((a,b)=>a+b,spent)>CAP)throw Error('total funding exceeds 0.02 tBNB cap');
 return plan;
}
const hasTask=id=>typeof id==='string'&&!/^0x0{64}$/.test(id);
const taskRecorded=({h,host})=>!!host.session.record?.taskId||!!h.record?.taskId||!!h.archives?.length;
export async function validateLiveSupport(client,market,mepId){
 const abi=parseAbi(['function protocolVersion() view returns(uint256)','function profileMaxInDegree(bytes32) view returns(uint32)']);
 const [version,degree]=await Promise.all([client.readContract({address:market,abi,functionName:'protocolVersion'}),client.readContract({address:market,abi,functionName:'profileMaxInDegree',args:[mepId]})]);
 if(version!==1n)throw Error('on-chain protocol version is not 1');
 if(degree<1||degree>16384)throw Error('exact profile certificate absent or unsupported');
}
export async function confirmedSmokeReady(args){
 if(taskRecorded(args)||args.h.readinessConsumed)return false;
 const p=await args.host.chain.pending();
 return p.ready&&!hasTask(p.taskId)&&await args.eligible(p);
}
export async function reconcileSmokeReadiness(args){
 const {h,host,eligible,commit}=args;
 if(taskRecorded(args)||h.readinessConsumed)return;
 const p=await host.chain.pending();
 if(hasTask(p.taskId)){h.readinessConsumed=true;commit();return;}
 if(p.ready){if(!h.armed){h.armed=true;commit();}return;}
 const authorizations=(host.idleRecord?.readiness||h.record?.readiness||[]).filter(a=>a.ready);
 // A consumed authorization followed by ready=false may mean the sole task was assigned
 // while this process was offline. Never create a second authorization in that case.
 if(authorizations.some(a=>BigInt(a.nonce)<p.nonce)){h.readinessConsumed=true;commit();return;}
 if(authorizations.some(a=>BigInt(a.nonce)>p.nonce))throw Error('readiness nonce regressed');
 if(!await eligible(p))return;
 // Latest can suppress a duplicate send, but never establish readiness or completion.
 const latestNonce=await host.chain.read('readinessNonce',[h.instance]);
 if(latestNonce>p.nonce)return;
 if(latestNonce<p.nonce)throw Error('latest readiness nonce regressed');
 const pending=authorizations.findLast(a=>BigInt(a.nonce)===p.nonce);
 if(pending&&await host.chain.client.getBlockNumber({cacheTime:0})<=BigInt(pending.expiry)){
  await host.send('readiness',pending); // exact original signature, already durably recorded
 }else await host.readiness(true); // no prior submission, or same nonce's signature expired
 h.armed=true;commit(); // advisory only; READY always rechecks finalized chain state
}
export class PrivateJournal{
 constructor(file){
  const dir=fs.realpathSync(path.dirname(path.resolve(file)));this.file=path.join(dir,path.basename(file));
  for(let p=dir;;p=path.dirname(p)){if(fs.existsSync(path.join(p,'.git')))throw Error('journal must be outside any repository');if(path.dirname(p)===p)break;}
  if(fs.existsSync(this.file)){const s=fs.lstatSync(this.file);if(!s.isFile()||s.isSymbolicLink()||(s.mode&0o777)!==0o600)throw Error('journal must be regular file mode 0600');}
 }
 load(){return fs.existsSync(this.file)?deserialize(fs.readFileSync(this.file)):null;}
 save(value){const temp=this.file+'.tmp';const fd=fs.openSync(temp,'wx',0o600);try{fs.writeFileSync(fd,serialize(value));fs.fsyncSync(fd);}finally{fs.closeSync(fd);}fs.renameSync(temp,this.file);const d=fs.openSync(path.dirname(this.file),'r');try{fs.fsyncSync(d);}finally{fs.closeSync(d);}}
}
export async function worker(identity,onAssignment){
 const base=path.join(ROOT,'contracts/lib/aigg-porw/web/porw-browser');
 const mod=n=>import(pathToFileURL(path.join(base,n)).href);
 const [{PorwNode},{loadKernelFromBytes},{RelayClient},{NodeService},{FamilyNodeService},{FamilyReplayJournal},V,L,model,delta]=await Promise.all(['node.js','porw.js','relay_client.js','node_service.js','family_service.js','family_journal.js','verify.js','lif.js','model.js','delta.js'].map(mod));
 const wasm=fs.readFileSync(path.join(base,'sketch.wasm'));
 const context={Uint8Array,Uint32Array,Map,Set,ArrayBuffer,BigInt,performance,setTimeout,clearTimeout,structuredClone,console,
  self:{postMessage:m=>{if(m.op==='synchronous-assignment')onAssignment(m.env);}},PorwNode,RelayClient,NodeService,FamilyNodeService,FamilyReplayJournal,V,L,...model,...delta,loadKernel:()=>loadKernelFromBytes(wasm)};
 vm.createContext(context);vm.runInContext(fs.readFileSync(path.join(ROOT,'frontend/public/node_worker.js'),'utf8').replace(/^import .*;$/gm,'')+'\n;globalThis.smokeOps=ops;',context);
 const ask=async(op,args)=>context.smokeOps[op](args);await ask('init',identity);return ask;
}
async function main(){
 const {values:a}=parseArgs({options:{relayer:{type:'string'},gateway:{type:'string'},journal:{type:'string'},payload:{type:'string'},mep:{type:'string'},'max-steps':{type:'string',default:'4'},broadcast:{type:'boolean',default:false}}});
 for(const k of ['relayer','gateway','journal','payload','mep'])if(!a[k])throw Error('missing --'+k);
 for(const k of ['relayer','gateway'])if(new URL(a[k]).protocol!=='https:')throw Error('public HTTPS URL required');
 if(!/^0x[0-9a-fA-F]{64}$/.test(a.mep))throw Error('invalid MEP');a.mep=a.mep.toLowerCase();
 const steps=Number(a['max-steps']);if(!Number.isInteger(steps)||steps<1||steps>16)throw Error('smoke max-steps must be 1..16');
 const journal=new PrivateJournal(a.journal),base=a.relayer.replace(/\/$/,'');
 const api=async(route,body)=>{if(body&&!a.broadcast)throw Error('broadcast flag required');const r=await fetch(base+route,{signal:AbortSignal.timeout(45000),...(body?{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body,(_,v)=>typeof v==='bigint'?String(v):v)}:{})});const j=await r.json();if(!r.ok||j.error||j.ok===false)throw Error('relayer request failed: '+route);return j;};
 const dep=await api('/deployment');validateDeployment(dep);const reader=clients(dep);
 if(await reader.pub.getChainId()!==97)throw Error('RPC chain mismatch');
 const mep=(await api('/meps')).find(m=>m.mepId.toLowerCase()===a.mep);
 if(!dep.verification.sponsorship?.configured)throw Error('synchronous sponsor budget unavailable');
 if(!mep||mep.exec!=='int-lif'||mep.baseMepId||!mep.verificationSupport?.supported)throw Error('requires supported exact base LIF profile');
 await validateLiveSupport(reader.pub,dep.addresses.market,a.mep);
 const unit=await reader.instances.read.UNIT();const initialPlan=fundingPlan(unit,[0n,0n]);
 const payload=new Uint8Array(fs.readFileSync(a.payload));
 // Verify the actual bytes/profile using WASM before allowing funding.
 const probe=await worker({},()=>{});const prepared=await probe('prepare',{mepId:a.mep,bytes:payload});
 const terms=mep.royaltyBps>0?{beneficiary:mep.beneficiary,royaltyBps:mep.royaltyBps}:null;
 const hostArgs={mepId:a.mep,name:prepared.name,maxSteps:steps,exec:'lif',wUnitQ16:mep.wUnitQ16||0,terms,family:true};
 if(!(await probe('host',hostArgs)).matches)throw Error('payload/profile mismatch');await probe('close');
 console.log(JSON.stringify({mode:a.broadcast?'broadcast':'dry-run',chainId:97,market:dep.addresses.market,mep:a.mep,gateway:a.gateway,fundingLimit:'0.02',plannedFunding:initialPlan.map(formatEther),scope:'hosts only; gateway request and cleanup are separate'}));
 if(!a.broadcast)return;
 const ownerKey=process.env.SMOKE_OWNER_KEY;if(!ownerKey)throw Error('SMOKE_OWNER_KEY required');const owner=clients(dep,ownerKey);
 const lock=fs.openSync(journal.file+'.lock','wx',0o600);fs.writeFileSync(lock,String(process.pid));fs.closeSync(lock);
 // Keep this lock on any failure: review uncertain transaction outcomes before removing it.
 let saved=journal.load();
 if(!saved){saved={version:1,chainId:97,market:dep.addresses.market,mep:a.mep,owner:owner.account.address,relayer:base,gateway:a.gateway,steps,funded:0n,hosts:[0,1].map(()=>({privateKey:generatePrivateKey(),sessionKey:generatePrivateKey(),announced:[],armed:false}))};journal.save(saved);}
 if(saved.chainId!==97||saved.market.toLowerCase()!==dep.addresses.market.toLowerCase()||saved.mep!==a.mep||saved.owner!==owner.account.address||saved.steps!==steps||saved.relayer!==base||saved.gateway!==a.gateway)throw Error('journal deployment or arguments mismatch');
 if(saved.fundingIntent)throw Error('uncertain funding transaction: review journal and chain before continuing');
 const commit=()=>journal.save(saved);const runtimes=[];
 const E=await import(pathToFileURL(path.join(ROOT,'contracts/lib/aigg-porw/web/porw-browser/eip712.js')).href);
 for(const h of saved.hosts){
  const c=clients(dep,h.privateKey),session=privateKeyToAccount(h.sessionKey);h.instance=c.account.address;
  const bonded=await c.instances.read.bonded([h.instance]);
  if(h.bondHash){const prior=await c.pub.getTransactionReceipt({hash:h.bondHash});if(prior.status!=='success')throw Error('prior bond reverted');}
  if(!bonded){
   if(h.bondIntent)throw Error('uncertain bond transaction: review chain before retry');
   const balance=await c.pub.getBalance({address:h.instance}),amount=fundingPlan(unit,[balance],saved.funded)[0];
   if(amount){saved.fundingIntent={to:h.instance,amount};commit();const hash=await owner.wallet.sendTransaction({to:h.instance,value:amount});saved.fundingIntent.hash=hash;commit();const receipt=await owner.pub.waitForTransactionReceipt({hash});if(receipt.status!=='success')throw Error('funding reverted');saved.funded+=amount;delete saved.fundingIntent;commit();}
   h.bondIntent=true;commit();const hash=await c.instances.write.bond([[a.mep]],{value:unit});h.bondHash=hash;commit();if((await c.pub.waitForTransactionReceipt({hash})).status!=='success')throw Error('bond reverted');
  }
  const capacityAbi=parseAbi(['function hostCapacity() view returns(address)','function capacityOf(address) view returns(uint16)','function setCapacity(uint16)']);
  const capacity=await c.pub.readContract({address:dep.addresses.market,abi:capacityAbi,functionName:'hostCapacity'});
  if(await c.pub.readContract({address:capacity,abi:capacityAbi,functionName:'capacityOf',args:[h.instance]})!==1){
   const hash=await c.wallet.writeContract({address:capacity,abi:capacityAbi,functionName:'setCapacity',args:[1]});h.capacityHash=hash;commit();if((await c.pub.waitForTransactionReceipt({hash})).status!=='success')throw Error('capacity reverted');
  }
  if(!h.delegation){const head=await c.pub.getBlockNumber();h.delegation=await E.makeDelegation(E.localWallet(h.privateKey),dep.domains.registry,session.address,Number(head+100000n));commit();}
  await api('/tx/delegate',{instance:h.delegation.instance,session:h.delegation.session,expiry:h.delegation.expiry,sig:h.delegation.sig});
  let host;const ask=await worker({privHex:h.sessionKey,domains:dep.domains,delegation:h.delegation},env=>host.assignment(env).catch(()=>{console.error('assignment failed; evidence retained for review');}));
  await ask('prepare',{mepId:a.mep,bytes:payload});
  await ask('relay',{url:dep.relay,synchronous:true});if(!(await ask('host',hostArgs)).matches)throw Error('host profile mismatch');
  const families=new Map([[a.mep,{...mep,maxSteps:steps,nameBytes:new TextEncoder().encode(prepared.name).length}]]);
  host=new SynchronousHost({deployment:dep,instance:h.instance,delegation:h.delegation,ask,sign:hash=>session.sign({hash}),
   locks:{request:async(_name,_options,fn)=>fn({})},journal:{load:async()=>h.record||null,save:async r=>{h.record=structuredClone(r);commit();},archive:async r=>{h.archives||=[];h.archives.push(structuredClone(r));commit();}},
   resolve:async env=>{if(env.mepId.toLowerCase()!==a.mep||env.payload.steps>steps)throw Error('smoke only accepts exact bounded profile');const resolver=createFamilyResolver({deployment:dep,instance:h.instance,families,client:{getChainId:()=>c.pub.getChainId(),getBlockNumber:async()=>(await c.pub.getBlock({blockTag:'finalized'})).number,readContract:x=>c.pub.readContract(x)}});const m=await resolver(env);m.baseTerms=terms;return m;},
   transport:(kind,p)=>api('/tx/sync/'+kind,p),onChange:s=>{h.status={phase:s.phase,safeToClose:s.safeToClose};}});
  const eligible=async p=>{const epoch=await c.claims.read.currentEpoch();return c.instances.read.isEligible([h.instance,a.mep,epoch],{blockNumber:p.blockNumber});};
  await host.start();runtimes.push({h,c,host,ask,eligible,commit});console.log('host resident: '+h.instance);
 }

 for(;;){
  for(const runtime of runtimes){
   const {h,c,host,ask}=runtime;
   await api('/wake',{instance:h.instance});
   if(!taskRecorded(runtime)&&!h.readinessConsumed){
    const ep=await api('/epoch?mep='+a.mep),epoch=Number(ep.epoch);
    if(!ep.rolled)continue;
    if(!h.announced.includes(epoch)){await ask('announce',{mepId:a.mep,challenge:ep.challenge});h.announced.push(epoch);commit();}
    for(const old of h.announced.filter(e=>e<epoch))try{await api('/tx/materialize',{mep:a.mep,epoch:old,instance:h.instance});}catch{/* claim root may not yet be posted */}
    await reconcileSmokeReadiness(runtime);
   }
   await host.tick();
  }
  if(!saved.readyAnnounced&&(await Promise.all(runtimes.map(confirmedSmokeReady))).every(Boolean)){saved.readyAnnounced=true;commit();console.log('READY: root may issue exactly one paid request via '+a.gateway);}
  if(runtimes.every(r=>r.host.session.record&&!r.host.session.record.idle&&r.host.session.status.safeToClose)){
   console.log(JSON.stringify({terminal:runtimes.map(r=>({instance:r.h.instance,taskId:r.host.session.record.taskId,...r.h.status})),cleanupRequired:true}));
   commit();for(const r of runtimes){await r.ask('syncRelease',{taskId:r.host.session.record.taskId,confirmedTerminal:true});await r.ask('close');r.host.unlock?.();}fs.unlinkSync(journal.file+'.lock');return;
  }
  await sleep(3000);
 }
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(()=>{console.error('Smoke stopped. No secret diagnostics printed. Preserve private journal/lock and inspect chain state before resuming.');process.exit(1);});
