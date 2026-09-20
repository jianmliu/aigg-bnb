// The PAGE hosting an individual of a collection, in headless Chromium. Two things make that different from hosting
// any other brain, and until now the page could do neither:
//
//   1. It is published as a DELTA -- a few hundred bytes of edits over a base the network already holds -- not as a
//      payload. What the page fetches from `weightsDA` is therefore not a brain, and it has to notice that, read
//      which base the delta edits, find that base among the brains this mesh serves, fetch it, and apply.
//   2. Its MEP carries TERMS, so its id is keccak(profileId, beneficiary, royaltyBps) and the terms are nowhere in
//      the bytes. A host that is not told them registers the model under the bare id, the chain draws tasks under
//      the other one, and the two never meet. The page's own check (`matches`) went quietly false and it served
//      nothing at all -- no error, no log, just a brain nobody could reach.
//
// So this runs the whole of it through the page: load, apply, host, and prove it is resident under the id the
// registry knows, by announcing a residency claim the relayer accepts for THAT id.
import fs from "node:fs";
import { parseAbi, parseEther } from "viem";
import * as H from "./harness.mjs";
import { startFrontend } from "../frontend/serve.mjs";
let fails = 0; const check = (n, ok, note = "") => { console.log((ok ? "  ok   " : "  FAIL ") + n + (ok || !note ? "" : "  " + note)); if (!ok) fails++; };
const waitFor = async (p, ms = 60000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await p().catch(() => false)) return true; await H.sleep(200); } return false; };

const BENEFICIARY = "0x6c4e3ebcf8d1ae3fce16f290cd1d839419925164", BPS = 1000;
const anvil = await H.startAnvil(8571); let browser; const stop = [];
try {
  const dep = await H.deploy(anvil.rpc, { EPOCH_BLOCKS: "200" });
  const { synthesizePayloadV2 } = await H.porw("synth.js"); const { PorwNode } = await H.porw("node.js"); const { loadKernelFromBytes } = await H.porw("porw.js");
  const { encodeDelta3, applyDelta, LAYOUT, fitName, baseNameLength } = await H.porw("delta.js"); const { withTerms } = await H.porw("mep.js");
  const wasm = fs.readFileSync(H.porwDir + "/sketch.wasm"); const STEPS = 4, N = 3000, NS = 30000;
  const probe = async (bytes) => { const nd = new PorwNode(await loadKernelFromBytes(wasm), { privHex: "0x" + "77".repeat(32) }); return nd.loadModel("base-brain", bytes, { maxSteps: STEPS, exec: "lif" }); };

  // The base everybody holds, and one individual of it -- written the way a collection writes them: a FLYDELTAv3
  // in the in-place layout, a couple of hundred bytes that say which base, which seed, and nothing else. The
  // individual's payload is what applying that produces; nobody publishes it, which is the whole point.
  const basePayload = synthesizePayloadV2("base-brain", N, NS);
  const baseProbe = await probe(basePayload);
  const delta = encodeDelta3({ baseModelId: baseProbe.mep.modelId, neurons: N, parentA: new Uint8Array(32), parentB: new Uint8Array(32),
    seed: 12345n, name: fitName("fly-1", baseNameLength(basePayload)), layout: LAYOUT.inplace });
  const flyPayload = applyDelta(basePayload, delta, { baseModelId: baseProbe.mep.modelId });

  const bs = baseProbe, fs_ = await probe(flyPayload);
  const fields = (st, da) => ({ modelId: H.hex(st.mep.modelId), schemeDigest: H.hex(st.mep.schemeDigest), execKind: H.hex(st.mep.execKind), neurons: st.hdr.neurons, synapses: st.hdr.synapses, synapseRoot: H.hex(st.csr.synapseRoot), weightsDA: "0x" + Buffer.from(da).toString("hex") });
  const D = H.clientsFor(dep, H.KEYS[0]);
  const withTermsAbi = parseAbi(["struct MEP { bytes32 modelId; bytes32 schemeDigest; bytes32 execKind; uint32 neurons; uint32 synapses; bytes32 synapseRoot; bytes weightsDA; }",
    "function registerMEPWithTerms(MEP m, address beneficiary, uint16 royaltyBps) returns (bytes32)"]);
  await D.pub.waitForTransactionReceipt({ hash: await D.meps.write.registerMEP([fields(bs, "gnfd://aigg-brains/base-brain.bin")]) });
  // the fly: registered under terms, and its weightsDA points at the DELTA, not at a brain
  await D.pub.waitForTransactionReceipt({ hash: await D.wallet.writeContract({ address: dep.addresses.meps, abi: withTermsAbi, functionName: "registerMEPWithTerms", args: [fields(fs_, "gnfd://aigg-brains/fly-1.delta"), BENEFICIARY, BPS] }) });
  const baseMepId = H.hex(bs.mep.mepId), flyMepId = H.hex(withTerms(fs_.mep, BENEFICIARY, BPS).mepId);
  check("the fly's id is not the id its own bytes produce: the terms are inside it", flyMepId !== H.hex(fs_.mep.mepId));

  const R = await H.startRelayer(dep, H.KEYS[3], [baseMepId, flyMepId]); stop.push(() => R.stop());
  const served = await R.api("/meps");
  check("the relayer serves both, and reports the fly's terms", served.length === 2 && served.find((m) => m.mepId === flyMepId)?.royaltyBps === BPS);

  // the page is given the delta at the fly's `weightsDA` and the base at the base's: exactly what a storage provider would serve
  const fe = await startFrontend(0, { payloads: { "/view/aigg-brains/fly-1.delta": delta, "/view/aigg-brains/base-brain.bin": basePayload } }); stop.push(() => fe.server.close());
  const W = H.clientsFor(dep, H.KEYS[1]);
  const launch = { headless: true }; if (process.env.PW_CHROMIUM) launch.executablePath = process.env.PW_CHROMIUM;
  browser = await browserOf(launch);
  const page = await browser.newPage(); const errors = []; page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  await page.exposeFunction("__walletRequest", async (method, params) => {
    switch (method) {
      case "eth_requestAccounts": case "eth_accounts": return [W.account.address];
      case "eth_chainId": return "0x" + dep.chainId.toString(16);
      case "eth_call": return W.pub.call({ to: params[0].to, data: params[0].data }).then((r) => r.data || "0x");
      case "eth_getBalance": return "0x" + (await W.pub.getBalance({ address: params[0] })).toString(16);
      case "eth_blockNumber": return "0x" + (await W.pub.getBlockNumber()).toString(16);
      case "eth_getTransactionReceipt": { try { const r = await W.pub.getTransactionReceipt({ hash: params[0] }); return { status: r.status === "success" ? "0x1" : "0x0" }; } catch { return null; } }
      case "eth_sendTransaction": { const t = params[0]; return W.wallet.sendTransaction({ to: t.to, data: t.data, value: t.value ? BigInt(t.value) : 0n }); }
      case "eth_signTypedData_v4": { const lw = (await H.porw("eip712.js")).localWallet(H.KEYS[1]); return lw.signTypedData(JSON.parse(params[1])); }
      default: throw new Error("unsupported " + method);
    }
  });
  await page.addInitScript(() => { window.ethereum = { isPorwTestWallet: true, request: ({ method, params }) => window.__walletRequest(method, params || []) }; });
  await page.goto(fe.url + "/"); await page.waitForFunction(() => window.__ready === true);
  await page.evaluate((u) => { document.getElementById("relayer").value = u; }, R.apiBase);
  await page.click("#btnDep"); await page.waitForFunction(() => window.app.state.meps.length === 2);
  await page.click("#navHost"); // the deposit, the key, the model and the node are the Host view

  // ---- loading: the page is handed a delta and has to work the rest out ----
  await page.evaluate((id) => window.appActions.setActive(id), flyMepId);
  await page.fill("#url", fe.url + "/view/aigg-brains/fly-1.delta");
  await page.fill("#sp", fe.url); // where the base can be fetched from, as a storage provider would be
  await page.click("#btnModel");
  const loaded = await waitFor(async () => !!(await page.evaluate((id) => window.app.state.loaded[id], flyMepId)));
  const L = await page.evaluate((id) => window.app.state.loaded[id], flyMepId);
  check("the page noticed the bytes were a delta, fetched the base itself, and applied it", loaded && L?.bytes === flyPayload.length, JSON.stringify(L));
  check("what it produced is the individual, by model_id, and it says so", L?.ok === true && L?.modelId?.toLowerCase() === H.hex(fs_.mep.modelId).toLowerCase());
  check("the log tells the story rather than a 200 MB surprise", /delta over/.test(await page.locator("#log").innerText()));

  // ---- hosting: under the id the registry knows, not the one the bytes make ----
  await page.evaluate((id) => window.appActions.host(id, true), flyMepId);
  await page.click("#btnConnect"); await page.waitForFunction(() => window.app.state.wallet !== null);
  await page.fill("#amount", "0.5"); await page.click("#btnBond"); await page.waitForFunction(() => window.app.state.bonded > 0n, null, { timeout: 60000 });
  check("bonded for the fly's MEP, by its terms id", await W.instances.read.isBondedFor([W.account.address, flyMepId]));
  await page.click("#btnDelegate"); await page.waitForFunction(() => window.app.state.resolved !== null, null, { timeout: 60000 });
  await page.click("#btnStart");
  check("the node holds it resident", await waitFor(async () => await page.evaluate((id) => !!window.app.state.node && [...window.app.state.node.models.keys()].includes(id), flyMepId), 120000));
  check("and under the TERMS id: the page's own id check passes, where it used to go quietly false",
    !/local MEP id/.test(await page.locator("#log").innerText()), (await page.locator("#log").innerText()).split("\n").filter((l) => /WARNING/.test(l)).join(" | "));
  check("no page errors while all this happened", errors.length === 0, errors.slice(0, 2).join(" | "));
} catch (e) { console.error(e); fails++; }
finally { if (browser) await browser.close(); for (const f of stop.reverse()) try { await f(); } catch {} anvil.stop(); }
async function browserOf(launch) { const { chromium } = await import("playwright"); return chromium.launch(launch); }
console.log(fails ? `${fails} FAILURES` : "host a fly: all checks passed"); process.exit(fails ? 1 : 0);
