// The node itself, off the main thread. Holding the brain resident and proving it is seconds of single-threaded
// wasm per epoch per brain -- on the main thread that is seconds of frozen page, every epoch, for every brain the
// tab hosts. Nothing here needs the DOM or the wallet, so all of it lives in a worker: the kernel, the resident
// models, the relay connection and the service that answers audits and tasks. The page keeps the UI, the wallet
// and the chain calls, and talks to this over a small request/response protocol.
//
// A plain worker, not a shared-memory one: it needs no SharedArrayBuffer, so the page needs no COOP/COEP and can
// fetch a brain from any host that does ordinary CORS. Restoring the multi-threaded kernel would mean taking
// those headers back on, deliberately, in exchange for the throughput.
import { loadKernel } from "/porw/porw.js";
import { PorwNode } from "/porw/node.js";
import { RelayClient } from "/porw/relay_client.js";
import { NodeService } from "/porw/node_service.js";
import { FamilyNodeService } from "/porw/family_service.js";
import { FamilyReplayJournal } from "/porw/family_journal.js";
import * as V from "/porw/verify.js";
import * as L from "/porw/lif.js";
import { decodeHeader } from "/porw/model.js";
import { isDelta2, isDelta3, decodeDelta2, decodeDelta3, deltaId, applyDelta, LAYOUT } from "/porw/delta.js";

const hex = (b) => "0x" + Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const unhex = (s) => Uint8Array.from(s.slice(2).match(/../g).map((h) => parseInt(h, 16)));
const reply = (m, data) => self.postMessage({ ok: true, reqId: m.reqId, ...data });
const say = (op, data) => self.postMessage({ op, ...data });

let node = null, rc = null, svc = null, familySvc = null, identity = null, familyMode = false;
let synchronousMode = false, synchronousTask = null;
let nextResolveId = 0;
const familyResolvers = new Map();
const resolveFamily = (env) => new Promise((resolve, reject) => {
  const resolveId = ++nextResolveId;
  const timer = setTimeout(() => { familyResolvers.delete(resolveId); reject(new Error("family resolution timed out")); }, 60000);
  familyResolvers.set(resolveId, { resolve, reject, timer });
  say("family-resolve", { resolveId, env });
});
// The base a delta was applied over, kept between prepares: the individuals of one collection all edit the same one,
// and re-fetching it per fly is tens of megabytes each time. One at a time, and only until `releaseBase`.
let heldBase = null;
const pending = new Map(); // mepId -> bytes, kept here so the page never holds a 28 MB payload

// This local synchronous adapter retains the exact child through terminal settlement.
// FamilyNodeService remains unchanged for legacy deployments, whose replay lifecycle differs.
const lower = x => typeof x === 'string' ? x.toLowerCase() : x;
const bytes = x => x instanceof Uint8Array ? x : new Uint8Array(x);
const id32 = x => typeof x === 'string' && /^0x[0-9a-f]{64}$/i.test(x);
const ZERO = '0x'+'00'.repeat(32);
class SynchronousFamilyExecution extends FamilyNodeService {
  async execute(manifest,type) {
    const m=manifest.mep,p=manifest.payload,baseId=lower(manifest.baseMepId),base=this.node.models.get(baseId);
    if(!base?.family||lower(m.enrollmentMepId)!==baseId)throw new Error('family base is not hosted');
    const root=lower(m.mepId)===baseId;
    if(!root&&lower(m.baseMepId)!==baseId)throw new Error('child base binding mismatch');
    if(!Number.isSafeInteger(p.steps)||p.steps<1||p.steps>base.maxSteps||!Number.isSafeInteger(p.commitStride)||p.commitStride<1||p.commitStride>0xffffffff||!id32(p.initStateRoot))throw new Error('task exceeds family execution capacity or has invalid parameters');
    if(type==='batch-announce'&&(!Array.isArray(p.runs)||p.runs.length<2||p.runs.length>this.maxRuns))throw new Error('batch exceeds family execution capacity');
    const ancestors=manifest.ancestors||[]; if(ancestors.length>this.maxAncestors)throw new Error('ancestry count limit');
    let total=manifest.delta?bytes(manifest.delta).length:0; const recipes=new Map();
    for(const a of ancestors) { const b=bytes(a.bytes),id=lower(a.id); total+=b.length; if(!id32(id)||hex(deltaId(b))!==id||recipes.has(id))throw new Error('ancestor content hash mismatch or duplicate'); recipes.set(id,b); }
    if(total>this.maxRecipeBytes)throw new Error('recipe byte limit');
    // JS keeps a genotype per ancestor; the ephemeral kernel also needs CSR, proofs and checkpoints.
    const estimated=base.nTiles*4096*3+base.hdr.synapses*(32+(ancestors.length+1)*4)+base.hdr.neurons*(512+(["spmv","int-spmv-q16"].includes(m.exec)?128*p.steps:16*Math.ceil(p.steps/32)));
    if(estimated>this.maxWorkingBytes)throw new Error('family derivation and execution memory limit');
    let payload=new Uint8Array(this.node.k.u8(base.bufPtr,base.nTiles*4096));
    if(!root) {
      if(!manifest.delta)throw new Error('child recipe missing');
      const delta=bytes(manifest.delta),path=new Set(),depths=new Map();
      const visit=(b,depth)=>{if(depth>this.maxDepth)throw new Error('ancestry depth limit'); const id=hex(deltaId(b));if(path.has(id))throw new Error('ancestry cycle');if((depths.get(id)??-1)>=depth)return;depths.set(id,depth);path.add(id);
        const d=decodeDelta3(b);if(d.layout!==LAYOUT.inplace||hex(d.baseModelId)!==hex(base.modelId)||d.neurons!==base.hdr.neurons||new TextEncoder().encode(d.name).length!==base.hdr.neuronOffset-30)throw new Error('recipe family or layout mismatch');
        for(const pid of [d.parentA,d.parentB].map(hex))if(pid!==ZERO){const par=recipes.get(pid);if(!par)throw new Error('missing ancestor recipe');visit(par,depth+1);}path.delete(id);};
      visit(delta,0);
      if(depths.size!==recipes.size+1)throw new Error('unused or duplicate ancestor recipe');
      payload=applyDelta(payload,delta,{baseModelId:base.modelId,resolve:id=>recipes.get(id)});
    } else if(manifest.delta||ancestors.length)throw new Error('root task cannot use child recipe');
    let child=await this.createNode();
    try {
      const terms=m.beneficiary&&lower(m.beneficiary)!=='0x'+'00'.repeat(20)?{beneficiary:m.beneficiary,royaltyBps:Number(m.royaltyBps)}:null;
      const st=await child.loadModel('family-task',payload,{maxSteps:p.steps,exec:({ 'int-lif':'lif','int-spmv-q16':'spmv' }[m.exec]||m.exec),wUnitQ16:Number(m.wUnitQ16||0),baseMepId:root?null:m.baseMepId,terms});
      if(hex(st.modelId)!==lower(m.modelId)||hex(st.mep.mepId)!==lower(m.mepId)||st.hdr.neurons!==Number(m.neurons)||st.hdr.synapses!==Number(m.synapses))throw new Error('derived child model or exact MEP mismatch');
      const handlers=new Map(); const service=new NodeService(child,{serve:(t,id,h)=>{handlers.set(t,h);return ()=>{};}},{maxRunsPerBatch:this.maxRuns});
      service.serve(st.mep.mepId);
      const response=await handlers.get(type)({type,mepId:hex(st.mep.mepId),payload:p});
      if(response?.type!=='result')throw new Error(response?.payload?.reason||'execution refused');
      this.retained = { node: child, mepId: st.mep.mepId, response, result: response.payload };
      return response;
    } finally { if (this.retained?.node !== child) { child.models.clear(); child.deltaBases.clear(); } payload=null; }
  }
 }
let synchronousExecution = null;
const synchronousReplies = new Map();
const ops = {
  async init({ privHex, domains, delegation }) {
    identity = { privHex, domains, delegation };
    node = new PorwNode(await loadKernel("/porw/sketch.wasm"), identity);
    return { address: hex(node.key.address) };
  },
  // model_id is the whole point of downloading a brain: the bytes are accepted only if they reproduce what the
  // MEP pins on-chain. Recomputing it is a keccak over every 4 KiB tile -- 28 MB of it, which is why it is here.
  /** What a brain's bytes are: a whole payload, or a DELTA that has to be applied to one. An individual of a
   *  collection is published as a delta -- a few hundred bytes of edits over a base everybody already has -- so
   *  `bytes` is then the base and `delta` the edits, and the model is what applying them produces. The page reads
   *  which it is from the bytes themselves and fetches the base if it has to; here the two cases only differ in
   *  where the payload comes from, and what is kept afterwards is the payload either way. */
  async deltaInfo({ bytes }) {
    const b = new Uint8Array(bytes);
    const d = isDelta3(b) ? decodeDelta3(b) : isDelta2(b) ? decodeDelta2(b) : null;
    if (!d) return { isDelta: false, bytes: b.length };
    if (d.layout !== undefined && d.layout !== LAYOUT.inplace) throw new Error("this delta is in the compact layout, which the page cannot apply yet");
    return { isDelta: true, baseModelId: hex(d.baseModelId), name: d.name ?? null, bytes: b.length };
  },
  /** Does this worker still hold the base a delta needs? Every individual of a collection is a delta over the same
   *  base, so preparing a second one should not mean fetching 77 MB again. Held only while brains are being
   *  prepared, and only one: `releaseBase` is what ends it, and the page calls that once the node is up. */
  async hasBase({ modelId }) { return { held: heldBase?.modelId === modelId?.toLowerCase(), bytes: heldBase?.bytes.length ?? 0 }; },
  async releaseBase() { const was = heldBase?.bytes.length ?? 0; heldBase = null; return { freed: was }; },
  async prepare({ mepId, bytes, delta = null, baseModelId = null }) {
    let b = bytes ? new Uint8Array(bytes) : null;
    if (!b && baseModelId && heldBase?.modelId === baseModelId.toLowerCase()) b = heldBase.bytes; // the base is already here
    if (!b) throw new Error("no bytes to prepare from");
    if (delta && baseModelId) heldBase = { modelId: baseModelId.toLowerCase(), bytes: b }; // keep it for the next individual
    // Applying is what produces the individual: byte for byte what a direct publication of it would have been, and
    // so the same model_id. The in-place layout applies in plain JS, which is why this needs no kernel and can run
    // before the node exists -- the page prepares a brain long before it decides to host one.
    if (delta) b = applyDelta(b, new Uint8Array(delta), { baseModelId: baseModelId ? unhex(baseModelId) : null });
    pending.set(mepId, b);
    const hdr = decodeHeader(b); const prof = V.profileOf(b, hdr); // model id AND the CSR roots: mep_id binds both now
    return { modelId: hex(prof.modelId), synapseRoot: hex(prof.synapseRoot), name: hdr.name, neurons: hdr.neurons, synapses: hdr.synapses, bytes: b.length, applied: !!delta };
  },
  /** `terms`: a profile registered under a beneficiary and a royalty is a DIFFERENT mep id from the same bytes,
   *  and the terms are nowhere in them -- so the host has to be told, or it serves an id nothing on-chain draws. */
  async host({ mepId, name, maxSteps, exec, wUnitQ16 = 0, baseMepId = null, terms = null, family = false }) {
    const bytes = pending.get(mepId); if (!bytes) throw new Error("no bytes prepared for this brain");
    const st = await node.loadModel(name, bytes, { maxSteps: maxSteps || 100, exec, wUnitQ16, baseMepId, terms }); // under another unit, or other terms, the same bytes are another MEP: the id check below is what catches a wrong one
    const local = hex(st.mep.mepId).toLowerCase();
    if (local === mepId.toLowerCase()) {
      st.family = family === true && (familyMode || synchronousMode);
      pending.delete(mepId);
      if (svc) svc.serve(st.mep.mepId, { tasks: !st.family && !synchronousMode });
    }
    return { localMepId: local, matches: local === mepId, neurons: st.hdr.neurons };
  },
  async relay({ url, familyMode: enabled = false, maxWorkingBytes = 2 * 1024 ** 3, synchronous = false }) {
    familySvc?.stop(); svc?.stop(); rc?.close();
    familyMode = enabled === true; synchronousMode = synchronous === true;
    rc = new RelayClient([url], node.key, { onLog: (m) => say("log", { msg: m }) }); const n = await rc.connect();
    svc = new NodeService(node, rc, { onResult: (res) => say("result", { res }) });
    if (familyMode && !synchronousMode) {
      const executionIdentity = identity;
      const namespace = JSON.stringify({ market: identity.domains?.market, instance: identity.delegation?.instance || hex(node.key.address) }).toLowerCase();
      familySvc = new FamilyNodeService(node, rc, { resolve: resolveFamily, maxWorkingBytes: Math.min(2 * 1024 ** 3, Number(maxWorkingBytes) || 2 * 1024 ** 3),
        createNode: async () => new PorwNode(await loadKernel("/porw/sketch.wasm"), executionIdentity),
        journal: new FamilyReplayJournal(namespace), onResult: (res) => say("result", { res }), onStatus: (status) => say("family-status", status) });
      familySvc.serve();
    }
    for (const st of node.models.values()) svc.serve(st.mep.mepId, { tasks: !st.family && !synchronousMode });
    if (synchronousMode) for (const type of ["task-announce", "batch-announce"]) rc.serve(type, null, async env => {
      if (!env?.payload?.taskId) return null;
      // Never publish the root/digest via the legacy request/reply path before commit/reveal.
      if (synchronousExecution?.taskId === env.payload.taskId && synchronousExecution.published) return synchronousExecution.published;
      const taskId=env.payload.taskId;
      if(synchronousReplies.size>=16&&!synchronousReplies.has(taskId))return {type:'result-refused',payload:{taskId,reason:'verification request capacity reached'}};
      const replies=synchronousReplies.get(taskId)||[];
      if(replies.length>=8)return {type:'result-refused',payload:{taskId,reason:'verification request capacity reached'}};
      const answer=new Promise(resolve=>replies.push(resolve));synchronousReplies.set(taskId,replies);
      say("synchronous-assignment", { env });
      return answer;
    });
    return { connected: n };
  },
  async taskReplay({ taskId }) { if (!familySvc) throw new Error("family service is not enabled"); return familySvc.replay(taskId); },
  async announce({ mepId, challenge }) {
    const t0 = performance.now(); const { r } = await svc.announce(unhex(mepId), unhex(challenge)); // residency only: no inference in a claim
    const t = r.timings || {}; const slot = (t.sketchMs || 0) + (t.commitMs || 0) + (t.inferMs || 0) + (t.disputeCommitMs || 0);
    return { claimHash: hex(r.claimHash), slotMs: Math.round(slot || performance.now() - t0) };
  },
  async syncManifest({ manifest }) {
    const base = node.models.get(manifest.baseMepId.toLowerCase());
    if (!base) throw new Error("synchronous base model not resident");
    return { manifest: { ...manifest, baseBytes: new Uint8Array(node.k.u8(base.bufPtr, base.nTiles * 4096)),
      baseOptions: { maxSteps: base.maxSteps, exec: base.exec, wUnitQ16: base.wUnitQ16,
        baseMepId: base.baseMepId ? hex(base.baseMepId) : null, terms: manifest.baseTerms || null } } };
  },
  async syncExecute({ taskId, manifest, expectedResult = null }) {
    await ops.syncPin({taskId});
    if (synchronousExecution?.taskId === taskId) return { result: synchronousExecution.result };
    if (manifest.mep.exec !== 'int-lif') throw new Error("synchronous responder currently requires int-lif");
    let baseNode = node;
    if (!baseNode.models.has(manifest.baseMepId.toLowerCase())) {
      baseNode = new PorwNode(await loadKernel("/porw/sketch.wasm"), identity);
      const base = await baseNode.loadModel('synchronous-recovery', bytes(manifest.baseBytes), manifest.baseOptions);
      if (hex(base.mep.mepId) !== manifest.baseMepId.toLowerCase()) throw new Error("recovered base identity mismatch");
      base.family = true;
    }
    const executor = new SynchronousFamilyExecution(baseNode, null, {
      createNode: async () => new PorwNode(await loadKernel("/porw/sketch.wasm"), identity), maxRuns: 64,
    });
    const response = await executor.execute(manifest, manifest.payload.runs ? 'batch-announce' : 'task-announce');
    const result = { execRoot: response.payload.execRoot, execDigest: response.payload.execDigest };
    if (expectedResult && (result.execRoot !== expectedResult.execRoot || result.execDigest !== expectedResult.execDigest)) throw new Error("synchronous replay does not reproduce the signed result");
    synchronousExecution = { ...executor.retained, taskId, result, manifest, openedRun: null };
    return { result };
  },
  async syncProof({ taskId, state: s }) {
    const e = synchronousExecution;
    if (!e || e.taskId !== taskId || synchronousTask !== taskId) throw new Error("synchronous evidence unavailable for task");
    const nd=e.node, id=e.mepId, me=nd.models.get(hex(id));
    const move=(functionName,args)=>({move:{functionName,args:[taskId,...args]}});
    if(s.phase===5) {
      if(s.party.posted || s.runOpened)return {move:null};
      if(s.batch.level>0) {const p=nd.batchNode(id,s.batch.level,s.batch.idx);return move('postChildren',p.map(hex));}
      const o=await nd.batchOpenRun(id,s.batch.idx);e.openedRun=s.batch.idx;e.runResult=o.result;
      return move('openRun',[hex(o.execRoot),o.seed,hex(o.initStateRoot),o.inputProof.map(hex)]);
    }
    // On restart the batch must reopen the selected run before single-run openings.
    if(e.manifest.payload.runs && e.openedRun!==s.batch.idx){const o=await nd.batchOpenRun(id,s.batch.idx);e.openedRun=s.batch.idx;e.runResult=o.result;}
    const r=e.runResult || { actRoots: me.actRoots };
    if(s.phase===0) {
      if(s.party.revealed)return {move:null};
      // execute()/batchOpenRun retain segment roots in the result captured below.
      const roots=r?.actRoots;
      if(!roots)throw new Error('segment commitment evidence unavailable');
      return move('revealRoots',[roots.map(hex)]);
    }
    if(s.phase===1){if(s.lifParty.refined)return {move:null};return move('postStepRoots',[(await nd.lifSegmentRoots(id,s.lif.seg)).roots.map(hex)]);}
    if(s.phase===2){if(s.party.posted)return {move:null};const width=Math.ceil(s.neurons/2**(s.level-1)),left=2*s.idx,right=Math.min(left+1,width-1);
      return move('postChildren',[hex(await nd.lifNode(id,s.step,s.level-1,left)),hex(await nd.lifNode(id,s.step,s.level-1,right))]);}
    if(s.phase===3){
      const sums=await nd.lifPartialSums(id,s.step,s.neuron),own=await nd.lifOpenState(id,s.step,s.neuron);
      if(!s.lifParty.rowPosted){const v=own.state,values=Array.from(sums.sums);if(values.length>1024){const offset=s.lifParty.sums.length;return move('postRowLifChunk',[offset,values.length,v.v,v.g,v.refr,v.flags,v.count,values.slice(offset,offset+1024)]);}return move('postRowLif',[v.v,v.g,v.refr,v.flags,v.count,values]);}
      if(!s.otherLifParty.rowPosted)return {move:null};
      const ours=s.lifParty.sums.map(BigInt),other=s.otherLifParty.sums.map(BigInt);
      let j=ours.findIndex((v,i)=>v!==other[i]);if(j<0)j=0;
      const k=sums.k0+j, chunkSize=me.csr.chunk;
      const start=nd.openRowStart(id,s.neuron),end=nd.openRowStart(id,s.neuron+1);
      const prev=await nd.lifOpenState(id,s.step-1,s.neuron);
      // Empty rows are decided by the transition/length check before the contract
      // accesses a synapse. In particular k0 can equal the model's synapse count.
      let chunk={c:0,records:new Uint8Array(),proof:[]},pre=prev;
      if(sums.sums.length){chunk=nd.openCsrChunk(id,Math.floor(k/chunkSize));const rec=L.recordSigned(chunk.records.subarray((k-chunk.k0)*10,(k-chunk.k0)*10+10));pre=await nd.lifOpenState(id,s.step-1,rec.pre);}
      const so=o=>[o.state.v,o.state.g,o.state.refr,o.state.flags,o.state.count,o.proof.map(hex)];
      const result={csrRoot:me.csr.csrTree.root,rowRoot:me.csr.rowTree.root};
      return move('proveSynapseTermLif',[[k,hex(result.csrRoot),hex(result.rowRoot),[start.value,start.proof.map(hex),end.value,end.proof.map(hex)],[chunk.c,hex(chunk.records),chunk.proof.map(hex)],so(prev),so(pre)]]);
    }
    return {move:null};
  },
  async syncPublish({taskId,signature,confirmedReveal=false}) {
    if(!confirmedReveal || !signature || synchronousExecution?.taskId!==taskId)throw new Error('confirmed reveal required before output publication');
    synchronousExecution.published={type:'result',payload:{...synchronousExecution.response.payload,signature}};
    for(const resolve of synchronousReplies.get(taskId)||[])resolve(synchronousExecution.published);synchronousReplies.delete(taskId);
    return {};
  },
  async syncRefuse({taskId,reason}) {for(const resolve of synchronousReplies.get(taskId)||[])resolve({type:'result-refused',payload:{taskId,reason}});synchronousReplies.delete(taskId);return {};},
  async syncPin({ taskId }) { if (synchronousTask && synchronousTask !== taskId) throw new Error("another active synchronous task owns the worker"); synchronousTask = taskId; return {}; },
  async syncRelease({ taskId, confirmedTerminal = false }) { if (taskId !== synchronousTask || !confirmedTerminal) throw new Error("confirmed terminal reconciliation required"); synchronousTask = null; synchronousExecution = null; return {}; },
  async close() { if (synchronousTask) throw new Error("synchronous session pending; retain evidence and finish verification"); familySvc?.stop(); svc?.stop(); for (const p of familyResolvers.values()) { clearTimeout(p.timer); p.reject(new Error("worker closed")); } familyResolvers.clear(); try { rc && rc.close(); } catch {} return {}; },
};

self.onmessage = async (ev) => {
  const m = ev.data;
  if (m.op === "familyResolved") { const p = familyResolvers.get(m.resolveId); if (p) { familyResolvers.delete(m.resolveId); clearTimeout(p.timer); m.error ? p.reject(new Error(m.error)) : p.resolve(m.manifest); } return; }
  const fn = ops[m.op];
  if (!fn) return self.postMessage({ ok: false, reqId: m.reqId, error: "unknown op " + m.op });
  try { reply(m, await fn(m)); } catch (e) { self.postMessage({ ok: false, reqId: m.reqId, error: String(e.message || e) }); }
};
