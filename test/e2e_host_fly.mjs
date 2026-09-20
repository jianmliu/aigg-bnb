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
import fs from "node:fs"; import http from "node:http";
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
  const delta2 = encodeDelta3({ baseModelId: baseProbe.mep.modelId, neurons: N, parentA: new Uint8Array(32), parentB: new Uint8Array(32),
    seed: 67890n, name: fitName("fly-2", baseNameLength(basePayload)), layout: LAYOUT.inplace });
  const fly2Payload = applyDelta(basePayload, delta2, { baseModelId: baseProbe.mep.modelId });

  const bs = baseProbe, fs_ = await probe(flyPayload), fs2 = await probe(fly2Payload);
  const fields = (st, da) => ({ modelId: H.hex(st.mep.modelId), schemeDigest: H.hex(st.mep.schemeDigest), execKind: H.hex(st.mep.execKind), neurons: st.hdr.neurons, synapses: st.hdr.synapses, synapseRoot: H.hex(st.csr.synapseRoot), weightsDA: "0x" + Buffer.from(da).toString("hex") });
  const D = H.clientsFor(dep, H.KEYS[0]);
  const withTermsAbi = parseAbi(["struct MEP { bytes32 modelId; bytes32 schemeDigest; bytes32 execKind; uint32 neurons; uint32 synapses; bytes32 synapseRoot; bytes weightsDA; }",
    "function registerMEPWithTerms(MEP m, address beneficiary, uint16 royaltyBps) returns (bytes32)"]);
  await D.pub.waitForTransactionReceipt({ hash: await D.meps.write.registerMEP([fields(bs, "gnfd://aigg-brains/base-brain.bin")]) });
  // the fly: registered under terms, and its weightsDA points at the DELTA, not at a brain
  await D.pub.waitForTransactionReceipt({ hash: await D.wallet.writeContract({ address: dep.addresses.meps, abi: withTermsAbi, functionName: "registerMEPWithTerms", args: [fields(fs_, "gnfd://aigg-brains/fly-1.delta"), BENEFICIARY, BPS] }) });
  await D.pub.waitForTransactionReceipt({ hash: await D.wallet.writeContract({ address: dep.addresses.meps, abi: withTermsAbi, functionName: "registerMEPWithTerms", args: [fields(fs2, "gnfd://aigg-brains/fly-2.delta"), BENEFICIARY, BPS] }) });
  const baseMepId = H.hex(bs.mep.mepId), flyMepId = H.hex(withTerms(fs_.mep, BENEFICIARY, BPS).mepId), fly2MepId = H.hex(withTerms(fs2.mep, BENEFICIARY, BPS).mepId);
  check("the fly's id is not the id its own bytes produce: the terms are inside it", flyMepId !== H.hex(fs_.mep.mepId));

  // a mirror of the base, as a deployment would name: an ordinary static host, trusted for nothing
  let mirrorHits = 0, mirrorUp = true;
  // a mirror that will not take a file whole, as Cloudflare Pages will not: the object 404s and the parts are there
  const PART = 64 * 1024; const nParts = Math.ceil(basePayload.length / PART); // small, so this synthetic base really does split
  const mirror = http.createServer((q, r) => {
    if (!mirrorUp) { r.writeHead(502, { "access-control-allow-origin": "*" }); return r.end("the mirror is down"); }
    const u = q.url.split("?")[0]; const cors = { "access-control-allow-origin": "*" };
    if (u.endsWith(".parts.json")) { r.writeHead(200, { ...cors, "content-type": "application/json" });
      return r.end(JSON.stringify({ parts: nParts, size: basePayload.length, part: PART })); }
    const m = /\.part(\d+)$/.exec(u);
    if (m) { const i = Number(m[1]); mirrorHits++; r.writeHead(200, { ...cors, "content-type": "application/octet-stream" });
      return r.end(Buffer.from(basePayload.subarray(i * PART, Math.min((i + 1) * PART, basePayload.length)))); }
    // what a static host really does with a missing path: 200 and its index page, not a 404
    r.writeHead(200, { ...cors, "content-type": "text/html; charset=utf-8" }); r.end("<!doctype html><title>mirror</title>");
  });
  await new Promise((r) => mirror.listen(0, "127.0.0.1", r)); stop.push(() => new Promise((r) => mirror.close(r)));
  const mirrorUrl = `http://127.0.0.1:${mirror.address().port}`;
  const R = await H.startRelayer(dep, H.KEYS[3], [baseMepId, flyMepId, fly2MepId], { env: { PORW_BRAIN_MIRRORS: mirrorUrl } }); stop.push(() => R.stop());
  const served = await R.api("/meps");
  check("the relayer serves the base and both individuals, with their terms", served.length === 3 && served.find((m) => m.mepId === flyMepId)?.royaltyBps === BPS);

  // the page is given the delta at the fly's `weightsDA` and the base at the base's: exactly what a storage provider would serve
  const fe = await startFrontend(0, { payloads: { "/view/aigg-brains/fly-1.delta": delta, "/view/aigg-brains/fly-2.delta": delta2 } }); stop.push(() => fe.server.close());
  // the base's storage provider, so the test can count what the page asks of it -- and refuse it
  let baseFetches = 0, blockBase = false;
  const sp = http.createServer((q, r) => {
    if (blockBase === "quota") { r.writeHead(406, { "content-type": "application/xml", "access-control-allow-origin": "*" });
      return r.end("<Error><Code>30004</Code><Message>bucket quota overflow</Message></Error>"); } // what Greenfield actually answers
    if (blockBase) { r.writeHead(503, { "access-control-allow-origin": "*" }); return r.end("the base is not available any more"); }
    baseFetches++; r.writeHead(200, { "content-type": "application/octet-stream", "access-control-allow-origin": "*" }); r.end(Buffer.from(basePayload));
  });
  await new Promise((r) => sp.listen(0, "127.0.0.1", r)); stop.push(() => new Promise((r) => sp.close(r)));
  const spUrl = `http://127.0.0.1:${sp.address().port}`;
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
  await page.click("#btnDep"); await page.waitForFunction(() => window.app.state.meps.length === 3);
  await page.click("#navHost"); // the deposit, the key, the model and the node are the Host view

  // ---- loading: the page is handed a delta and has to work the rest out ----
  await page.evaluate((id) => window.appActions.setActive(id), flyMepId);
  await page.fill("#url", fe.url + "/view/aigg-brains/fly-1.delta");
  await page.fill("#sp", spUrl); // where the base can be fetched from, as a storage provider would be
  await page.click("#btnModel");
  const loaded = await waitFor(async () => !!(await page.evaluate((id) => window.app.state.loaded[id], flyMepId)));
  const L = await page.evaluate((id) => window.app.state.loaded[id], flyMepId);
  check("the page noticed the bytes were a delta and fetched the base itself", loaded && L?.bytes === flyPayload.length, JSON.stringify(L));
  check("it took the base from the MIRROR the deployment names, and left the storage provider alone", mirrorHits === nParts && baseFetches === 0, `mirror served ${mirrorHits} of ${nParts} part(s), storage provider ${baseFetches}`);
  check("a host that answers 200-and-a-web-page for a missing file does not pass it off as a brain", nParts > 1 && L?.ok === true, `${nParts} parts`);
  check("what it produced is the individual, by model_id, and it says so", L?.ok === true && L?.modelId?.toLowerCase() === H.hex(fs_.mep.modelId).toLowerCase());
  check("the log tells the story rather than a 200 MB surprise", /delta over/.test(await page.locator("#log").innerText()));

  // ---- a second individual of the same collection ----
  // Every fly edits the SAME base, so the second one must not cost another download of it. Proved by making the
  // base unfetchable first: if the page still needs it, this fails, and if it kept it, nothing notices.
  baseFetches = 0; blockBase = true;
  await page.evaluate((id) => window.appActions.setActive(id), fly2MepId);
  await page.fill("#url", fe.url + "/view/aigg-brains/fly-2.delta");
  await page.click("#btnModel");
  const loaded2 = await waitFor(async () => !!(await page.evaluate((id) => window.app.state.loaded[id], fly2MepId)));
  const L2 = await page.evaluate((id) => window.app.state.loaded[id], fly2MepId);
  check("a second individual loads with the base already in hand, and no second download", loaded2 && L2?.ok === true && baseFetches === 0, `fetches ${baseFetches}, ${JSON.stringify(L2)}`);
  check("it is a different individual, not the first one again", L2?.modelId?.toLowerCase() === H.hex(fs2.mep.modelId).toLowerCase() && L2.modelId !== L.modelId);
  check("the page says so rather than going quiet", /already here/.test(await page.locator("#log").innerText()));

  // ---- hosting: under the id the registry knows, not the one the bytes make ----
  await page.evaluate((id) => window.appActions.host(id, true), flyMepId);
  await page.click("#btnConnect"); await page.waitForFunction(() => window.app.state.wallet !== null);
  await page.fill("#amount", "0.5"); await page.click("#btnBond"); await page.waitForFunction(() => window.app.state.bonded > 0n, null, { timeout: 60000 });
  check("bonded for the fly's MEP, by its terms id", await W.instances.read.isBondedFor([W.account.address, flyMepId]));
  await page.click("#btnDelegate"); await page.waitForFunction(() => window.app.state.resolved !== null, null, { timeout: 60000 });
  await page.click("#btnStart");
  check("the node holds it resident", await waitFor(async () => await page.evaluate((id) => !!window.app.state.node && [...window.app.state.node.models.keys()].includes(id), flyMepId), 120000));
  check("once the node is up the base is let go: it is only needed while individuals are being prepared",
    /released the .* base/.test(await page.locator("#log").innerText()));
  check("and under the TERMS id: the page's own id check passes, where it used to go quietly false",
    !/local MEP id/.test(await page.locator("#log").innerText()), (await page.locator("#log").innerText()).split("\n").filter((l) => /WARNING/.test(l)).join(" | "));
  // ---- the base cannot be fetched: the commonest thing that will go wrong for a real host ----
  // A hundred individuals of a collection pull the same tens of megabytes, so the bucket's read allowance is the
  // first thing to run out -- and it did, on the testnet, mid-verification. The page used to sit on "loading" for
  // ever: the failure went to the log as nothing anybody could act on, and no view said a word.
  { blockBase = "quota"; mirrorUp = false; // the base was released when the node started, so this load has to go and fetch it
    await page.evaluate((id) => window.appActions.setActive(id), flyMepId);
    await page.fill("#url", fe.url + "/view/aigg-brains/fly-1.delta");
    await page.click("#btnModel");
    const said = await waitFor(async () => /quota/i.test(await page.locator("#log").innerText()), 30000);
    const line = (await page.locator("#log").innerText()).split("\n").filter((l) => /406|quota/i.test(l)).join(" ");
    check("a refused base is reported in the storage provider's own words, not swallowed", said, line || "(the log says nothing about it)");
    check("and it says what to do about it, since waiting will not help", /topped up|another provider/i.test(line), line);
    check("and it says it tried the mirror first", /mirror|127\.0\.0\.1/.test(await page.locator("#log").innerText()));
    blockBase = false; mirrorUp = true; }

  // the 406 above is deliberate, and the browser logs every refused request: it is the one expected noise
  { const unexpected = errors.filter((e) => !/406|502|404/.test(e)); // the refusals and the whole-object probe are this test's doing
    check("no page errors while all this happened, beyond the refusal this test asked for", unexpected.length === 0, unexpected.slice(0, 2).join(" | ")); }
} catch (e) { console.error(e); fails++; }
finally { if (browser) await browser.close(); for (const f of stop.reverse()) try { await f(); } catch {} anvil.stop(); }
async function browserOf(launch) { const { chromium } = await import("playwright"); return chromium.launch(launch); }
console.log(fails ? `${fails} FAILURES` : "host a fly: all checks passed"); process.exit(fails ? 1 : 0);
