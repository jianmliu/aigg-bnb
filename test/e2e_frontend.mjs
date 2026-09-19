// The frontend in headless Chromium against the anvil harness: an injected wallet (simulated OUTSIDE the page —
// it signs and sends with viem on anvil) connects, bonds BNB, delegates a session key (one typed-data prompt),
// loads the model, starts the node; epochs are driven with anvil_mine; the page announces claims, materializes
// through the relayer, and executes a task posted by another client. TWO brains are hosted at once (the female
// and a "male" synthetic MEP): the selector switches the model panel; claims, materialization and tasks run for both.
import fs from "node:fs"; import path from "node:path";
import { chromium } from "playwright";
import { parseEther, keccak256, encodePacked } from "viem";
import * as H from "./harness.mjs";
import { startFrontend } from "../frontend/serve.mjs";
let fails = 0; const check = (n, ok) => { console.log((ok ? "  ok   " : "  FAIL ") + n); if (!ok) fails++; };
const anvil = await H.startAnvil(8556); let browser;
try {
  const dep = await H.deploy(anvil.rpc); const { mep, mepId, payload, steps } = await H.registerSyntheticMep(dep, H.KEYS[0]);
  const M2 = await H.registerSyntheticMep(dep, H.KEYS[0], { name: "male-cns", neurons: 3000, synapses: 30000, steps: 3 }); const mepId2 = M2.mepId;
  const R = await H.startRelayer(dep, H.KEYS[3], [mepId, mepId2]);
  const fe = await startFrontend(0, { payloads: { "/payload.bin": payload, "/payload2.bin": M2.payload } });
  // the "wallet": anvil account 1, signing outside the page
  const W = H.clientsFor(dep, H.KEYS[1]); const E = await H.porw("eip712.js"); const localWallet = E.localWallet(H.KEYS[1]); const prompts = [];
  const launch = { headless: true }; if (process.env.PW_CHROMIUM) launch.executablePath = process.env.PW_CHROMIUM;
  browser = await chromium.launch(launch); const page = await browser.newPage(); page.on("console", (m) => { if (m.type() === "error") console.error("page:", m.text()); });
  await page.exposeFunction("__walletRequest", async (method, params) => {
    switch (method) {
      case "eth_requestAccounts": case "eth_accounts": return [W.account.address];
      case "eth_chainId": return "0x" + dep.chainId.toString(16);
      case "eth_call": return W.pub.call({ to: params[0].to, data: params[0].data }).then((r) => r.data || "0x");
      case "eth_getBalance": return "0x" + (await W.pub.getBalance({ address: params[0] })).toString(16);
      case "eth_blockNumber": return "0x" + (await W.pub.getBlockNumber()).toString(16);
      case "eth_getTransactionReceipt": { try { const r = await W.pub.getTransactionReceipt({ hash: params[0] }); return { status: r.status === "success" ? "0x1" : "0x0" }; } catch { return null; } }
      case "eth_sendTransaction": { const t = params[0]; prompts.push("tx"); return W.wallet.sendTransaction({ to: t.to, data: t.data, value: t.value ? BigInt(t.value) : 0n }); }
      case "eth_signTypedData_v4": { prompts.push(JSON.parse(params[1]).primaryType); return localWallet.signTypedData(JSON.parse(params[1])); }
      default: throw new Error("unsupported " + method);
    }
  });
  await page.addInitScript(() => { window.ethereum = { isPorwTestWallet: true, request: ({ method, params }) => window.__walletRequest(method, params || []) }; });
  await page.goto(fe.url + "/"); await page.waitForFunction(() => window.__ready === true);
  await page.evaluate((u) => { document.getElementById("relayer").value = u; }, R.apiBase);
  await page.click("#btnDep"); await page.waitForFunction(() => window.app.state.deployment !== null);
  await page.click("#navHost"); // the deposit, the key, the model and the node are the Host view
  check("Host view has a provider dashboard with a disconnected state", await page.locator("#provider-dashboard").count() === 1 && /Connect your wallet/.test(await page.locator("#provider-dashboard").textContent().catch(() => "")));
  check("page loaded the deployment + two MEPs from the relayer", (await page.evaluate(() => window.app.state.meps.map((m) => m.mepId))).join() === [mepId, mepId2].map((x) => x.toLowerCase()).join());
  await page.evaluate((id) => window.appActions.host(id, true), mepId2.toLowerCase()); check("hosting both brains", (await page.evaluate(() => window.app.state.hosted.size)) === 2);
  await page.click("#btnConnect"); await page.waitForFunction(() => window.app.state.wallet !== null);
  check("wallet connected on the right chain", (await page.evaluate(() => [window.app.state.wallet, window.app.state.chainOk]))[1] === true);
  await page.fill("#amount", "0.5"); await page.click("#btnBond"); await page.waitForFunction(() => window.app.state.bonded > 0n, null, { timeout: 60000 });
  check("bonded 0.5 BNB through the wallet (10 votes) for BOTH MEPs", (await W.instances.read.weightOf([W.account.address])) === 10n && (await W.instances.read.isBondedFor([W.account.address, mepId2])));
  await page.click("#btnDelegate"); await page.waitForFunction(() => window.app.state.resolved !== null, null, { timeout: 60000 });
  check("session key delegated: one Delegation prompt, resolves to the wallet", (await page.evaluate(() => window.app.state.resolved)) === W.account.address.toLowerCase() && prompts.filter((p) => p === "Delegation").length === 1);
  await page.fill("#url", "/payload.bin"); await page.click("#btnModel"); await page.waitForFunction((id) => !!window.app.state.loaded[id], mepId.toLowerCase(), { timeout: 60000 });
  check("female model loaded in the tab, model_id matches the MEP", (await page.evaluate((id) => window.app.state.loaded[id].ok, mepId.toLowerCase())) === true);
  await page.evaluate((id) => window.appActions.setActive(id), mepId2.toLowerCase()); await page.fill("#url", "/payload.bin"); await page.click("#btnModel"); await page.waitForFunction((id) => !!window.app.state.loaded[id], mepId2.toLowerCase(), { timeout: 60000 });
  check("switching to the male MEP and loading the WRONG bytes is flagged (model_id mismatch)", (await page.evaluate((id) => window.app.state.loaded[id].ok, mepId2.toLowerCase())) === false);
  await page.fill("#url", "/payload2.bin"); await page.click("#btnModel"); await page.waitForFunction((id) => window.app.state.loaded[id].ok === true, mepId2.toLowerCase(), { timeout: 60000 }); check("male model loaded, model_id matches", true);
  check("task capacity defaults to 100 and is editable", (await page.inputValue("#steps")) === "100" && await page.isEnabled("#steps"));
  // the capacity buys memory, and memory is what bounds how many brains a tab holds — so the page shows the bill
  { const at100 = await page.textContent("#model");
    await page.fill("#steps", "5000"); await page.dispatchEvent("#steps", "input"); const at5000 = await page.textContent("#model");
    const mb = (t) => Number((t.match(/~(\d+) MB resident/) || [])[1]);
    check(`the page projects resident memory for the capacity asked for (${mb(at100)} MB at 100 steps, ${mb(at5000)} MB at 5000)`,
      mb(at100) > 0 && mb(at5000) > mb(at100) * 2);
    await page.fill("#steps", "100"); await page.dispatchEvent("#steps", "input"); }
  for (const value of ["", "0", "-1", "1.5", "513"]) {
    await page.fill("#steps", value);
    const error = await page.evaluate(async () => { try { await window.appActions.startNode(); return null; } catch (e) { return e.message; } });
    check(`invalid SPMV task capacity ${JSON.stringify(value)} is rejected before starting the worker`, /Max task steps/.test(error || "") && await page.evaluate(() => window.app.state.node === null));
  }
  await page.fill("#steps", "3");
  await page.click("#btnStart"); await page.waitForFunction(() => window.app.state.node !== null && window.app.state.node.models.size === 2, null, { timeout: 120000 }); check("node started hosting both brains", true);
  // epochs: commit / reveal / roll driven by anvil_mine; the page claims each epoch and materializes the previous one
  const EPOCH = dep.epochBlocks; const toBlock = async (b) => { const cur = await anvil.block(); if (b > cur) await anvil.mine(b - cur); };
  const waitFor = async (pred, ms = 30000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await pred()) return true; await H.sleep(400); } return false; };
  const enterEpoch = async (e) => { await toBlock(e * EPOCH - 5); await waitFor(async () => (await R.api("/status")).commits.includes(e)); await toBlock(e * EPOCH + 2); await waitFor(async () => (await R.api("/status")).reveals.includes(e)); await toBlock(e * EPOCH + 12); return waitFor(async () => (await R.api("/status")).epochsRolled.includes(e)); };
  await enterEpoch(1); check("page announced epoch-1 claims for both MEPs", await waitFor(() => page.evaluate(([a, b]) => !!window.app.state.claims[a]?.[1] && !!window.app.state.claims[b]?.[1], [mepId.toLowerCase(), mepId2.toLowerCase()])));
  await enterEpoch(2); check("page materialized both epoch-1 claims through the relayer", await waitFor(() => page.evaluate(([a, b]) => window.app.state.materialized[a]?.[1] === true && window.app.state.materialized[b]?.[1] === true, [mepId.toLowerCase(), mepId2.toLowerCase()]), 60000));
  check("on-chain: valid claims + eligible in epoch 2 for both MEPs", (await W.instances.read.isEligible([W.account.address, mepId, 2n])) && (await W.instances.read.isEligible([W.account.address, mepId2, 2n])));
  // a task from another client: the page's session inbox gets the announcement, the relayer submits the page's result
  const C = H.clientsFor(dep, H.KEYS[0]); const nonce = "0x" + "41".repeat(32);
  const task = { mepId: mepId2, stimulusSeed: 7, steps: 3, commitStride: 1, initStateRoot: "0x" + "00".repeat(32), fee: parseEther("0.01"), deadline: BigInt(await anvil.block() + 50), redundancy: 1 };
  await C.pub.waitForTransactionReceipt({ hash: await C.market.write.postTask([task, nonce], { value: parseEther("0.01") }) });
  const taskId = H.taskIdOf(task, nonce); const ex = await C.market.read.executors([taskId]);
  check("the tab's wallet is the sortitioned executor", ex.length === 1 && ex[0].toLowerCase() === W.account.address.toLowerCase());
  const { RelayClient } = await H.porw("relay_client.js"); const { keypair } = await H.porw("claim.js"); const client = new RelayClient([(await R.api("/deployment")).relay], keypair(H.KEYS[0])); await client.connect();
  const session = await page.evaluate(() => document.getElementById("session").textContent.split(" ")[2]);
  const resp = await client.request(session, "task-announce", mepId2, { taskId, stimulusSeed: task.stimulusSeed, steps: task.steps, commitStride: task.commitStride }, { timeoutMs: 60000, responseType: "result" });
  check("tab executed a task on the MALE brain and returned a signed result", resp.payload.taskId === taskId);
  const Vf = await H.porw("verifier.js"); const { loadKernelFromBytes } = await H.porw("porw.js"); const re = Vf.reexecute(await loadKernelFromBytes(fs.readFileSync(path.join(H.porwDir, "sketch.wasm"))), M2.payload, { stimulusSeed: 7, steps: 3, execDigest: H.unhex(resp.payload.execDigest) });
  check("the result matches an independent re-execution of the male brain (3 steps)", re.matches);
  check("relayer submitted the tab's result on-chain", await waitFor(async () => C.market.read.submitted([taskId, W.account.address])));
  const s = await R.api("/tx/settle", { taskId, instance: W.account.address }); check("task settled, fee paid to the tab's wallet", s.ok);
  check("Host dashboard updates settled request count and earned BNB", await waitFor(async () => await page.locator("#host-served").textContent().catch(() => "") === "1", 20000));
  check("Host dashboard separates local online models from chain earnings", await page.locator("#host-online").textContent().catch(() => "") === "2" && /0.01 BNB/.test(await page.locator("#host-earned").textContent().catch(() => "")));
  if (process.env.M3_SCREENSHOT) { await page.locator("#provider-dashboard").scrollIntoViewIfNeeded(); await page.screenshot({ path: process.env.M3_SCREENSHOT }); }
  await page.route(R.apiBase + "/hosts?**", (route) => route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "RPC unavailable" }) }));
  check("unavailable chain data is shown as unavailable, never zero earnings", await waitFor(async () => /Hosting activity is unavailable/.test(await page.locator("#provider-dashboard").textContent()), 15000) && await page.locator("#host-earned").textContent() === "—");
  console.log(`wallet prompts: ${prompts.join(",")}`); console.log("page log tail:\n" + (await page.evaluate(() => document.getElementById("log").textContent)).split("\n").slice(-8).join("\n"));
  client.close(); R.stop(); fe.server.close();
} catch (e) { console.error(e); fails++; } finally { if (browser) await browser.close(); anvil.stop(); }
console.log(fails ? `${fails} FAILURES` : "ALL PASS"); process.exit(fails ? 1 : 0);
