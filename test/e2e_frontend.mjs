// The frontend in headless Chromium against the anvil harness: an injected wallet (simulated OUTSIDE the page —
// it signs and sends with viem on anvil) connects, bonds BNB, delegates a session key (one typed-data prompt),
// loads the model, starts the node; epochs are driven with anvil_mine; the page announces claims, materializes
// through the relayer, and executes a task posted by another client.
import fs from "node:fs"; import path from "node:path";
import { chromium } from "playwright";
import { parseEther, keccak256, encodePacked } from "viem";
import * as H from "./harness.mjs";
import { startFrontend } from "../frontend/serve.mjs";
let fails = 0; const check = (n, ok) => { console.log((ok ? "  ok   " : "  FAIL ") + n); if (!ok) fails++; };
const anvil = await H.startAnvil(8556); let browser;
try {
  const dep = await H.deploy(anvil.rpc); const { mep, mepId, payload, steps } = await H.registerSyntheticMep(dep, H.KEYS[0]);
  const R = await H.startRelayer(dep, H.KEYS[3], [mepId]);
  const fe = await startFrontend(0, { payload });
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
  check("page loaded the deployment from the relayer", (await page.evaluate(() => window.app.state.deployment.meps[0])) === mepId.toLowerCase());
  await page.click("#btnConnect"); await page.waitForFunction(() => window.app.state.wallet !== null);
  check("wallet connected on the right chain", (await page.evaluate(() => [window.app.state.wallet, window.app.state.chainOk]))[1] === true);
  await page.fill("#amount", "0.5"); await page.click("#btnBond"); await page.waitForFunction(() => window.app.state.bonded > 0n, null, { timeout: 60000 });
  check("bonded 0.5 BNB through the wallet (10 votes)", (await W.instances.read.weightOf([W.account.address])) === 10n);
  await page.click("#btnDelegate"); await page.waitForFunction(() => window.app.state.resolved !== null, null, { timeout: 60000 });
  check("session key delegated: one Delegation prompt, resolves to the wallet", (await page.evaluate(() => window.app.state.resolved)) === W.account.address.toLowerCase() && prompts.filter((p) => p === "Delegation").length === 1);
  await page.fill("#url", "/payload.bin"); await page.click("#btnModel"); await page.waitForFunction(() => window.app.state.model !== null, null, { timeout: 60000 });
  check("model loaded in the tab with a locally verified model_id", (await page.evaluate(() => window.app.state.model.modelId)) === H.hex(mep.modelId));
  await page.click("#btnStart"); await page.waitForFunction(() => window.app.state.node !== null, null, { timeout: 120000 }); check("node started (relay connected, serving)", true);
  // epochs: commit / reveal / roll driven by anvil_mine; the page claims each epoch and materializes the previous one
  const EPOCH = dep.epochBlocks; const toBlock = async (b) => { const cur = await anvil.block(); if (b > cur) await anvil.mine(b - cur); };
  const waitFor = async (pred, ms = 30000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await pred()) return true; await H.sleep(400); } return false; };
  const enterEpoch = async (e) => { await toBlock(e * EPOCH - 5); await waitFor(async () => (await R.api("/status")).commits.includes(e)); await toBlock(e * EPOCH + 2); await waitFor(async () => (await R.api("/status")).reveals.includes(e)); await toBlock(e * EPOCH + 12); return waitFor(async () => (await R.api("/status")).epochsRolled.includes(e)); };
  await enterEpoch(1); check("page announced its epoch-1 claim", await waitFor(() => page.evaluate(() => !!window.app.state.claims[1])));
  await enterEpoch(2); check("page materialized its epoch-1 claim through the relayer", await waitFor(() => page.evaluate(() => window.app.state.materialized[1] === true), 40000));
  check("on-chain: valid claim + eligible in epoch 2", (await W.claims.read.hasValidClaim([W.account.address, mepId, 1n])) && (await W.instances.read.isEligible([W.account.address, mepId, 2n])));
  // a task from another client: the page's session inbox gets the announcement, the relayer submits the page's result
  const C = H.clientsFor(dep, H.KEYS[0]); const nonce = "0x" + "41".repeat(32);
  await C.pub.waitForTransactionReceipt({ hash: await C.market.write.postTask([{ mepId, stimulusSeed: 7, inputCommit: "0x" + "00".repeat(32), fee: parseEther("0.01"), deadline: BigInt(await anvil.block() + 50), redundancy: 1 }, nonce], { value: parseEther("0.01") }) });
  const taskId = keccak256(encodePacked(["bytes32", "uint32", "bytes32"], [mepId, 7, nonce])); const ex = await C.market.read.executors([taskId]);
  check("the tab's wallet is the sortitioned executor", ex.length === 1 && ex[0].toLowerCase() === W.account.address.toLowerCase());
  const { RelayClient } = await H.porw("relay_client.js"); const { keypair } = await H.porw("claim.js"); const client = new RelayClient([(await R.api("/deployment")).relay], keypair(H.KEYS[0])); await client.connect();
  const session = await page.evaluate(() => document.getElementById("session").textContent.split(" ")[2]);
  const resp = await client.request(session, "task-announce", mepId, { taskId, stimulusSeed: 7 }, { timeoutMs: 60000, responseType: "result" });
  check("tab executed the task and returned a signed result", resp.payload.taskId === taskId);
  check("relayer submitted the tab's result on-chain", await waitFor(async () => C.market.read.submitted([taskId, W.account.address])));
  const s = await R.api("/tx/settle", { taskId }); check("task settled, fee paid to the tab's wallet", s.ok);
  console.log(`wallet prompts: ${prompts.join(",")}`); console.log("page log tail:\n" + (await page.evaluate(() => document.getElementById("log").textContent)).split("\n").slice(-8).join("\n"));
  client.close(); R.stop(); fe.server.close();
} catch (e) { console.error(e); fails++; } finally { if (browser) await browser.close(); anvil.stop(); }
console.log(fails ? `${fails} FAILURES` : "ALL PASS"); process.exit(fails ? 1 : 0);
