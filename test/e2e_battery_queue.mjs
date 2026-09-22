// A batched task, end to end on a local anvil: one task, several runs of the same brain, posted with
// TaskMarket.postBatch, announced to the sortitioned executors as one "batch-announce", executed by two live nodes,
// submitted through the relayer and settled -- and then the same again with one node lying about ONE neuron at ONE
// step of ONE run. The market notices when it tries to settle; the dispute first bisects the two run-result trees to
// the run (Phase.Run), both sides open it, and from there it is the ordinary dispute, shared with e2e_dispute.mjs,
// down to a single signed synapse term and the liar's bond.
//
// What a batch buys is in the numbers the test prints: the chain's cost for N runs is the cost of one task.
import fs from "node:fs"; import path from "node:path"; import os from "node:os"; import {spawn} from "node:child_process";
import { parseEther, keccak256 } from "viem";
import {batteryBatch,resolvedRuns} from "../flybnb/battery/battery_batch.mjs";
import * as H from "./harness.mjs";
import {state0Root} from "../gateway/state0.mjs";
let fails = 0; const check = (n, ok) => { console.log((ok ? "  ok   " : "  FAIL ") + n); if (!ok) fails++; };
const TOKEN=process.env.TEST_TOKEN_BATTERY==='1';
const factoryName=TOKEN?'TokenBatteryBudget':'BatteryBudget',jobName=TOKEN?'TokenBatteryJob':'BatteryJob';
H.forgeBuild();
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),"battery-live-"));let worker;const clean=[];
const anvil = await H.startAnvil(8569);
try {
  const dep = await H.deploy(anvil.rpc,TOKEN?{MULTI_ASSET_MARKET:'true'}:{});
  let token;
  if(TOKEN){const admin=H.clientsFor(dep,H.KEYS[0]);token=await H.create(admin,'TestToken');await H.sendTo(admin,dep.addresses.market,'MultiAssetTaskMarket','setTokenAllowed',[token,true]);}
  const { synthesizePayloadV2 } = await H.porw("synth.js"); const { PorwNode } = await H.porw("node.js"); const { loadKernelFromBytes } = await H.porw("porw.js");
  const { RelayClient } = await H.porw("relay_client.js"); const { NodeService } = await H.porw("node_service.js"); const { keypair } = await H.porw("claim.js");
  const E = await H.porw("eip712.js"); const V = await H.porw("verify.js"); const D = await H.porw("dispute.js"); const L = await H.porw("lif.js"); const B = await H.porw("batch.js");
  const wasm = fs.readFileSync(path.join(H.porwDir, "sketch.wasm"));
  const STEPS = 20, STRIDE = 5, SEED = 9, NEURONS = 3000, SYNAPSES = 30000, STAR = 3;
  const payload = synthesizePayloadV2("lif-batch", NEURONS, SYNAPSES);

  // ---- the brain, and the runs: seeds, an explicit stimulus set, a silence set; run STAR is the canonical one ----
  const probe = new PorwNode(await loadKernelFromBytes(wasm), { privHex: H.KEYS[4] });
  const pst = await probe.loadModel("lif-batch", payload, { maxSteps: STEPS, exec: "lif" }); const mep = pst.mep, mepId = H.hex(mep.mepId), n = pst.hdr.neurons;
  { const c = H.clientsFor(dep, H.KEYS[0]);
    await c.pub.waitForTransactionReceipt({ hash: await c.meps.write.registerMEP([{ modelId: H.hex(mep.modelId), schemeDigest: H.hex(mep.schemeDigest), execKind: H.hex(mep.execKind), neurons: n, synapses: pst.hdr.synapses, synapseRoot: H.hex(pst.csr.synapseRoot), weightsDA: "0x" + Buffer.from("gnfd://aigg-brains/lif-batch.bin").toString("hex") }]) }); }
  const sets = { ears: Array.from({ length: 250 }, (_, j) => j * 9), quiet: [40, 41, 42, 900, 1500, 2200] };
  const RUNS = [{ stimulusSeed: 3 }, { stimulusSeed: 4 }, { stimulusSeed: 5, silenceSet: "quiet" }, { stimulusSeed: SEED }, { stimulusSeed: 7, stimulusSet: "ears" }, { stimulusSeed: 7, stimulusSet: "ears", silenceSet: "quiet" }];
  const resolved = RUNS.map((r) => ({ stimulusSeed: r.stimulusSeed, stimulusIds: r.stimulusSet ? Uint32Array.from(sets[r.stimulusSet]) : null, silenceIds: r.silenceSet ? Uint32Array.from(sets[r.silenceSet]) : null }));
  const { runsRoot } = await probe.batchRunsRoot(mep.mepId, resolved);

  // ---- a neuron in run STAR where lying about the input changes the state (as in e2e_dispute) ----
  const challengeBytes = new Uint8Array(32).fill(7);
  await probe.challenge(mep.mepId, challengeBytes, { steps: STEPS, commitStride: STRIDE, stimulusSeed: SEED });
  const S_LIE = 8; const prevStates = await probe.lifStates(mep.mepId, S_LIE - 1); let NEURON = -1, DELTA = 40;
  for (let i = 1; i < n && NEURON < 0; i++) { const S = L.decodeState(prevStates, i * 16); if (S.refr > 0 || (S.flags & 1)) continue;
    const ps = await probe.lifPartialSums(mep.mepId, S_LIE, i); if (ps.sums.length < 3) continue; const last = ps.sums[ps.sums.length - 1];
    for (const cand of [40, 400, 4000, 40000, 400000]) if (!L.sameState(L.transition(S, last, i, S_LIE, SEED), L.transition(S, last + BigInt(cand), i, S_LIE, SEED))) { NEURON = i; DELTA = cand; break; } }
  check(`a neuron whose state changes if one input term is inflated (neuron ${NEURON}, delta ${DELTA})`, NEURON > 0);

  // ---- two bonded instances behind the relayer, eligible from epoch 2 ----
  const R = await H.startRelayer(dep, H.KEYS[3], [mepId]); clean.push(()=>R.stop()); const d0 = await R.api("/deployment"); const domains = d0.domains;
  const mk = async (walletKey, sessionByte) => {
    const c = H.clientsFor(dep, walletKey); const wallet = E.localWallet(walletKey); const session = keypair("0x" + sessionByte.repeat(32));
    if(TOKEN)await H.sendTo(c,dep.addresses.market,'MultiAssetTaskMarket','setAcceptedToken',[token,true]);
    await c.pub.waitForTransactionReceipt({ hash: await c.instances.write.bond([[mepId]], { value: parseEther("0.5") }) });
    const del = await E.makeDelegation(wallet, domains.registry, H.hex(session.address), 100000); await R.api("/tx/delegate", { instance: del.instance, session: del.session, expiry: del.expiry, sig: del.sig });
    const nd = new PorwNode(await loadKernelFromBytes(wasm), { privHex: "0x" + sessionByte.repeat(32), domains, delegation: del }); await nd.loadModel("lif-batch", payload, { maxSteps: STEPS, exec: "lif" });
    const rc = new RelayClient([d0.relay], nd.key); await rc.connect(); const results = [];
    const svc = new NodeService(nd, rc, { onResult: async (res) => { results.push(res); res.relayer = await R.api("/tx/result", res); } }); svc.serve(mep.mepId);
    return { c, wallet, session, nd, rc, svc, results, addr: wallet.address.toLowerCase() };
  };
  const A = await mk(H.KEYS[1], "11"), Bn = await mk(H.KEYS[2], "22"); clean.push(()=>A.rc.close(),()=>Bn.rc.close());
  const EPOCH = dep.epochBlocks; const toBlock = async (b) => { const cur = await anvil.block(); if (b > cur) await anvil.mine(b - cur); };
  const waitFor = async (p, ms = 25000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await p()) return true; await H.sleep(250); } return false; };
  const enterEpoch = async (e) => { await toBlock(e * EPOCH - 5); await waitFor(async () => (await R.api("/status")).commits.includes(e)); await toBlock(e * EPOCH + 2); await waitFor(async () => (await R.api("/status")).reveals.includes(e)); await toBlock(e * EPOCH + 12); return waitFor(async () => (await R.api("/status")).epochsRolled.includes(e)); };
  check("epoch 1 rolled", await enterEpoch(1)); const ep = await R.api("/epoch?mep=" + mepId); for (const X of [A, Bn]) await X.svc.announce(mep.mepId, H.unhex(ep.challenge));
  check("epoch 2 rolled, the epoch-1 root posted", (await enterEpoch(2)) && await waitFor(async () => (await R.api("/status")).rootsPosted.some((r) => r.epoch === 1 && r.count === 2)));
  const mA = await R.api("/tx/materialize", { mep: mepId, epoch: 1, instance: A.addr }), mB = await R.api("/tx/materialize", { mep: mepId, epoch: 1, instance: Bn.addr }); check("both eligible", mA.ok && mB.ok);


  const payer=H.clientsFor(dep,H.KEYS[0]),op=H.clientsFor(dep,H.KEYS[4]);
  const collection=await H.deployCollection(dep,0n);
  await H.adoptBoth(payer,collection);
  await H.sendTo(payer,collection,"FlyCollection","register",[1n,H.GENESIS.DF,{modelId:H.hex(mep.modelId),schemeDigest:H.hex(mep.schemeDigest),execKind:H.hex(mep.execKind),neurons:n,synapses:pst.hdr.synapses,synapseRoot:H.hex(pst.csr.synapseRoot),weightsDA:"0x"}]);
  const spec={version:1,neurons:n,steps:STEPS,commit_stride:STRIDE,seeds:[3,4,5],stimuli:[{name:"ears",neuron_index:sets.ears},{name:"quiet",neuron_index:sets.quiet}],readout:{neuron_index:[0,1,2]}};
  const raw=JSON.stringify(spec);fs.writeFileSync(path.join(tmp,'battery.json'),raw);
  const rr=resolvedRuns(batteryBatch(spec));
  // Use the deployment policy's model-independent input commitment. Reusing the probe after
  // a trajectory replay retains upstream incremental-tree state and can commit stale leaves.
  const inputRoot=V.merkleRoot(rr.map((r,k)=>B.runLeaf(k,r.stimulusSeed,state0Root(n,r.stimulusSeed,[...r.stimulusIds]).root)));
  const policy={versionHash:keccak256(Buffer.from(raw)),runsRoot:H.hex(inputRoot),runs:rr.length,steps:STEPS,stride:STRIDE,redundancy:2,attempts:2,fee:parseEther('0.01'),lifetime:3600};
  const factory=await H.create(payer,factoryName,[collection,dep.addresses.market,op.account.address,policy,...(TOKEN?[token,'0x'+'0'.repeat(40)]:[])]);
  if(TOKEN){await H.sendTo(payer,token,'TestToken','mint',[payer.account.address,parseEther('0.02')]);await H.sendTo(payer,token,'TestToken','approve',[factory,parseEther('0.02')]);}
  await H.sendTo(payer,factory,factoryName,'fund',[1n],TOKEN?0n:parseEther('0.02'));
  const job=await H.readFrom(payer,factory,factoryName,'jobOf',[1n]);
  const balance=address=>TOKEN?H.readFrom(payer,token,'TestToken','balanceOf',[address]):payer.pub.getBalance({address});
  check('execution budget is locked outside treasury',await balance(job)===parseEther('0.02'));
  fs.mkdirSync(path.join(tmp,'models'));fs.writeFileSync(path.join(tmp,'models',H.hex(mep.modelId)+'.bin'),payload);
  fs.writeFileSync(path.join(tmp,'deployment.json'),JSON.stringify(dep));
  let output='';const start=()=>{worker=spawn(process.execPath,['battery/worker.mjs'],{cwd:H.root,env:{...process.env,BATTERY_ASSET_MODE:TOKEN?'token':'native',BATTERY_DEPLOYMENT:path.join(tmp,'deployment.json'),BATTERY_BUDGET:factory,BATTERY_KEY:H.KEYS[4],BATTERY_SPEC:path.join(tmp,'battery.json'),BATTERY_MODELS:path.join(tmp,'models'),BATTERY_STATE:path.join(tmp,'state'),BATTERY_RELAY:d0.relay,BATTERY_PORT:'0',BATTERY_POLL_MS:'100',BATTERY_RESULT_TIMEOUT_MS:'10000'},stdio:['ignore','pipe','pipe']});worker.stdout.on('data',x=>output+=x);worker.stderr.on('data',x=>output+=x);};
  start();
  const posted=await waitFor(async()=>{if(worker.exitCode!==null)throw Error('battery worker exited: '+output);return await H.readFrom(payer,job,jobName,'taskId')!=='0x'+'0'.repeat(64);},30000);
  check('queue posted a real batched task',posted);if(!posted)throw Error('queue did not post: '+output);
  const tid=await H.readFrom(payer,job,jobName,'taskId');
  check('hosts executed and the task settled',await waitFor(async()=>{const t=await payer.pub.readContract({address:dep.addresses.market,abi:H.artifact('TaskMarket').abi,functionName:'tasks',args:[tid]});return t[6];},30000));
  // Restart after settlement, before finality: the chain retains task identity and budget consumption.
  worker.kill('SIGTERM');await new Promise(r=>{if(worker.exitCode!==null)r();else worker.once('exit',r);});start();
  await anvil.mine(100);
  check('restarted queue verifies and publishes delivered output',await waitFor(async()=>await H.readFrom(payer,job,jobName,'artifactHash')!=='0x'+'0'.repeat(64),30000));
  check('restart did not submit another paid attempt',await H.readFrom(payer,job,jobName,'attempt')===1n);
  const file=path.join(tmp,'state','artifacts',job.toLowerCase()+'.json');
  check('all battery rows are published with execution evidence',fs.existsSync(file)&&JSON.parse(fs.readFileSync(file)).rows.length===rr.length);
  { const art=JSON.parse(fs.readFileSync(file)); check('the artifact names the recipe by content address, so an audit can rebuild the payload (battery/audit.mjs)',art.deltaHash?.toLowerCase()===H.GENESIS.DF.toLowerCase()&&/^0x[0-9a-f]{64}$/.test(art.baseModelId)&&art.modelId.toLowerCase()===H.hex(mep.modelId).toLowerCase()); }
  const before=await balance(job);await H.sendTo(payer,job,jobName,'refund');
  check('unused retry reserve is recoverable',before===parseEther('0.01')&&await balance(job)===0n);
  if(TOKEN){
   check('task commits its token', (await H.readFrom(payer,dep.addresses.market,'MultiAssetTaskMarket','paymentToken',[tid])).toLowerCase()===token.toLowerCase());
   check('both executing hosts earned tokens',await balance(A.addr)===parseEther('0.005')&&await balance(Bn.addr)===parseEther('0.005'));
   check('artifact records payment token',JSON.parse(fs.readFileSync(file)).paymentToken.toLowerCase()===token.toLowerCase());
   const earnings=await R.api('/hosts?instance='+A.addr);
   check('host API segregates tokens from BNB',earnings.earnedWei==='0'&&earnings.tokenEarnings?.[token.toLowerCase()]===String(parseEther('0.005')));
  }
  if(fails)console.error(output.slice(-6000));
} catch(e){console.error(e);fails++;} finally {if(worker){worker.kill('SIGTERM');await new Promise(r=>{if(worker.exitCode!==null)r();else worker.once('exit',r);});}for(const f of clean)f();anvil.stop();fs.rmSync(tmp,{recursive:true,force:true});}
console.log(fails?`${fails} FAILURES`:'battery queue: all checks passed');process.exit(fails?1:0);
