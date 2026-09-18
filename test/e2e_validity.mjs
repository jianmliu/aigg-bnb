// The claim validity window end to end on anvil: deployed with CLAIM_VALIDITY_EPOCHS=3, one instance claims in epoch 1 and
// materializes once in epoch 2; it then stays eligible through epoch 4 without another transaction and ages out in epoch 5.
// The relayer reports the window so a node page can materialize once every k epochs instead of every epoch.
import fs from "node:fs"; import path from "node:path"; import { parseEther } from "viem"; import * as H from "./harness.mjs";
let fails = 0; const check = (n, ok) => { console.log((ok ? "  ok   " : "  FAIL ") + n); if (!ok) fails++; };
const anvil = await H.startAnvil(8557);
try {
  const dep = await H.deploy(anvil.rpc, { CLAIM_VALIDITY_EPOCHS: "3" }); check("deployed with a 3-epoch claim validity window (recorded in the deployment file)", dep.claimValidityEpochs === 3);
  const { mep, mepId, payload, steps } = await H.registerSyntheticMep(dep, H.KEYS[0]); const R = await H.startRelayer(dep, H.KEYS[3], [mepId]); const d = await R.api("/deployment");
  check("the relayer reports the window", d.claimValidityEpochs === 3);
  const E = await H.porw("eip712.js"); const { keypair } = await H.porw("claim.js"); const { PorwNode } = await H.porw("node.js"); const { loadKernelFromBytes } = await H.porw("porw.js"); const { RelayClient } = await H.porw("relay_client.js"); const { NodeService } = await H.porw("node_service.js");
  const wasm = fs.readFileSync(path.join(H.porwDir, "sketch.wasm")); const c = H.clientsFor(dep, H.KEYS[1]); const wallet = E.localWallet(H.KEYS[1]); const session = keypair("0x" + "11".repeat(32));
  await c.pub.waitForTransactionReceipt({ hash: await c.instances.write.bond([[mepId]], { value: parseEther("0.5") }) });
  const del = await E.makeDelegation(wallet, d.domains.registry, H.hex(session.address), 100000); await R.api("/tx/delegate", { instance: del.instance, session: del.session, expiry: del.expiry, sig: del.sig });
  const nd = new PorwNode(await loadKernelFromBytes(wasm), { privHex: "0x" + "11".repeat(32), domains: d.domains, delegation: del }); await nd.loadModel("flywire-female", payload, { maxSteps: steps });
  const rc = new RelayClient([d.relay], nd.key); await rc.connect(); const svc = new NodeService(nd, rc, {}); svc.serve(mep.mepId); const addr = wallet.address;
  const EPOCH = dep.epochBlocks; const toBlock = async (b) => { const cur = await anvil.block(); if (b > cur) await anvil.mine(b - cur); }; const waitFor = async (pred, ms = 20000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await pred()) return true; await H.sleep(300); } return false; };
  const enterEpoch = async (e) => { await toBlock(e * EPOCH - 5); await waitFor(async () => (await R.api("/status")).commits.includes(e)); await toBlock(e * EPOCH + 2); await waitFor(async () => (await R.api("/status")).reveals.includes(e)); await toBlock(e * EPOCH + 12); return waitFor(async () => (await R.api("/status")).epochsRolled.includes(e)); };
  const eligible = (e) => c.instances.read.isEligible([addr, mepId, BigInt(e)]);
  check("epoch 1 rolled", await enterEpoch(1)); const ep = await R.api("/epoch?mep=" + mepId); await svc.announce(mep.mepId, H.unhex(ep.challenge));
  check("epoch 2 rolled, the epoch-1 root posted", (await enterEpoch(2)) && await waitFor(async () => (await R.api("/status")).rootsPosted.some((r) => r.epoch === 1)));
  check("not eligible before materializing", !(await eligible(2)));
  const m = await R.api("/tx/materialize", { mep: mepId, epoch: 1, instance: addr }); check(`one materialization (gas ${m.gasUsed})`, m.ok);
  check("eligible in epochs 2, 3 and 4 on that one transaction; aged out in epoch 5", (await eligible(2)) && (await eligible(3)) && (await eligible(4)) && !(await eligible(5)));
  check("epochs 3 and 4 roll with no further claim on-chain and the instance is still drawn", (await enterEpoch(3)) && (await enterEpoch(4)) && (await c.instances.read.eligibleVotes([mepId, 4n])).length === 10);
  const txs = (await R.api("/status")).txs.filter((t) => /materializeClaim/.test(t.label)).length; check(`the relayer sponsored ${txs} materialization across four epochs`, txs === 1);
  rc.close(); R.stop();
} catch (e) { console.error(e); fails++; } finally { anvil.stop(); }
console.log(fails ? `${fails} FAILURES` : "ALL PASS"); process.exit(fails ? 1 : 0);
