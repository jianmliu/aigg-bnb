// Treasury inventory adoption through the real page and contracts on Anvil.
import fs from "node:fs"; import path from "node:path";
import { chromium } from "playwright"; import { parseEther } from "viem";
import * as H from "./harness.mjs"; import { startFrontend } from "../frontend/serve.mjs";
let fails = 0; const check = (n, ok) => { console.log((ok ? "  ok   " : "  FAIL ") + n); if (!ok) fails++; };
const G = JSON.parse(fs.readFileSync(path.join(H.root, "flybnb/genesis/genesis-v1.json"), "utf8"));
H.forgeBuild();
const anvil = await H.startAnvil(8567); let browser; const stop = [];
try {
  const dep = await H.deployMesh(anvil.rpc);
  const base = await H.registerSyntheticMep(dep, H.KEYS[0], { name: "inventory-base" });
  const T = H.clientsFor(dep, H.KEYS[0]), W = H.clientsFor(dep, H.KEYS[1]);
  const PRICE = parseEther("0.123456789");
  const C = await H.deployCollection(dep, 0n, H.KEYS[0], { genesis: G });
  for (const g of G.individuals.slice(0, 2)) await H.sendTo(T, C, "FlyCollection", "mint", [g.index, g.sex, g.deltaHash, g.proof], H.FLY_PRICE);
  const S = await H.create(T, "TreasuryInventorySale", [C, T.account.address]);
  await H.sendTo(T, C, "FlyCollection", "approve", [S, 1n]);
  const expiry = (await T.pub.getBlock()).timestamp + 3600n;
  await H.sendTo(T, S, "TreasuryInventorySale", "list", [1n, PRICE, expiry]);
  const R = await H.startRelayer(dep, H.KEYS[3], [base.mepId], { env: { PORW_BEACON_LAZY: "1", PORW_COLLECTION: C, PORW_INVENTORY_SALE: S, PORW_KEEPER: "0" } }); stop.push(() => R.stop());
  const fe = await startFrontend(0); stop.push(() => fe.server.close()); const prompts = [];
  const launch = { headless: true }; if (process.env.PW_CHROMIUM) launch.executablePath = process.env.PW_CHROMIUM;
  browser = await chromium.launch(launch);
  const visitor = await browser.newPage();
  await visitor.goto(fe.url); await visitor.waitForFunction(() => window.__ready === true);
  await visitor.evaluate((u) => { document.getElementById("relayer").value = u; }, R.apiBase);
  await visitor.click("#btnDep"); await visitor.waitForFunction(() => window.app.state.deployment !== null);
  await visitor.click("#navFlies"); await visitor.waitForFunction(() => window.app.state.flies?.all.length === 2, null, { timeout: 5000 });
  check("colony loads automatically for a visitor without a wallet", await visitor.locator("#fly-1").isVisible());
  let failRead = true;
  await visitor.route(dep.rpc, async route => {
    const body = route.request().postDataJSON();
    if (failRead && body?.method === "eth_call" && body.params[0].data.startsWith("0x18160ddd")) {
      failRead = false;
      return route.fulfill({ json: { jsonrpc: "2.0", id: body.id, error: { code: -32000, message: "Temporary colony RPC failure" } } });
    }
    return route.continue();
  });
  await visitor.click("#btnFlies");
  await visitor.getByRole("alert").waitFor();
  check("a failed refresh shows an actionable error and preserves the colony", (await visitor.getByRole("alert").innerText()).includes("Refresh to retry") && await visitor.locator("#fly-1").isVisible());
  await visitor.click("#btnFlies");
  await visitor.getByRole("alert").waitFor({ state: "detached" });
  await visitor.waitForFunction(() => !document.getElementById("btnFlies").disabled);
  await visitor.unroute(dep.rpc);

  await visitor.click("#btnGenesis"); await visitor.waitForFunction(() => window.app.state.flies?.sale?.open.length === 1);
  check("visitors can inspect listed inventory without a wallet but cannot buy", await visitor.isDisabled("#btnAdopt-1"));
  await visitor.close();
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } }); page.on("console", (m) => { if (m.type() === "error") console.error("page:", m.text()); });
  await page.exposeFunction("__walletRequest", async (method, params) => {
    switch (method) {
      case "eth_requestAccounts": case "eth_accounts": return [W.account.address];
      case "eth_chainId": return "0x" + dep.chainId.toString(16);
      case "eth_call": return W.pub.call({ to: params[0].to, data: params[0].data }).then((r) => r.data || "0x");
      case "eth_getBalance": return "0x" + (await W.pub.getBalance({ address: params[0] })).toString(16);
      case "eth_getBlockByNumber": return W.pub.request({method, params});
      case "eth_blockNumber": return "0x" + (await W.pub.getBlockNumber()).toString(16);
      case "eth_getTransactionReceipt": { try { const r = await W.pub.getTransactionReceipt({ hash: params[0] }); return { status: r.status === "success" ? "0x1" : "0x0" }; } catch { return null; } }
      case "eth_sendTransaction": { const t = params[0]; prompts.push("tx"); return W.wallet.sendTransaction({ to: t.to, data: t.data, value: t.value ? BigInt(t.value) : 0n }); }
      default: throw new Error("unsupported " + method);
    }
  });
  await page.addInitScript(() => { window.ethereum = { isPorwTestWallet: true, request: ({ method, params }) => window.__walletRequest(method, params || []) }; });
  await page.goto(fe.url + "/"); await page.waitForFunction(() => window.__ready === true);
  await page.evaluate((u) => { document.getElementById("relayer").value = u; }, R.apiBase);
  await page.click("#btnDep"); await page.waitForFunction(() => window.app.state.deployment !== null);
  await page.click("#btnConnect"); await page.waitForFunction(() => window.app.state.wallet !== null);
  await page.click("#navFlies"); await page.click("#btnFlies"); await page.waitForFunction(() => window.app.state.flies && !window.app.state.flies.missing);


  await page.click("#btnGenesis"); await page.waitForFunction(() => window.app.state.flies?.sale?.open.length === 1);
  check("only listed treasury inventory is displayed", await page.locator("#adoptable .brain.listing").count() === 1);
  check("the exact quoted price is displayed", (await page.locator("#btnAdopt-1").innerText()).includes("0.123456789 BNB"));
  check("purchase excludes host collateral and liquidity", (await page.locator("#adoptFee").innerText()).includes("No Host bond"));
  // Bind the displayed revision: cancelling and relisting at the same price invalidates the old quote.
  await H.sendTo(T, S, "TreasuryInventorySale", "cancel", [1n]);
  await H.sendTo(T, S, "TreasuryInventorySale", "list", [1n, PRICE, expiry]);
  const stale = await page.evaluate(async () => { try { await window.appActions.adopt(1); return false; } catch { return true; } });
  check("old quote cannot execute after relisting", stale && (await H.readFrom(T, C, "FlyCollection", "ownerOf", [1n])).toLowerCase() === T.account.address.toLowerCase());
  await page.click("#btnGenesis"); await page.waitForFunction(() => window.app.state.flies?.sale?.open[0]?.revision === 3n);
  const before = await T.pub.getBalance({address:T.account.address});
  await page.click("#btnAdopt-1"); await page.waitForFunction(() => window.app.state.flies?.all[0]?.mine === true, null, {timeout:60000});
  await page.waitForFunction(() => window.app.state.flies?.sale?.open.length === 0);
  check("buyer owns the NFT and supply is unchanged", (await H.readFrom(W,C,"FlyCollection","ownerOf",[1n])).toLowerCase() === W.account.address.toLowerCase() && await H.readFrom(W,C,"FlyCollection","totalSupply") === 2n);
  check("all BNB reaches seller treasury", (await T.pub.getBalance({address:T.account.address})) - before === PRICE);
  check("adoption does not create a host bond", await W.instances.read.bonded([W.account.address]) === 0n);
  const again = await page.evaluate(async () => { try { await window.appActions.adopt(1); return false; } catch { return true; } });
  check("sold NFT cannot be adopted again", again && await page.locator("#btnAdopt-1").count() === 0);
  await page.evaluate(async () => { delete window.app.state.deployment.addresses.inventorySale; await window.appActions.loadGenesis(); });
  check("missing sale configuration fails closed", (await page.locator("body").innerText()).includes("Treasury adoption is not configured"));
} catch (e) { console.error(e); fails++; } finally { if (browser) await browser.close(); for (const f of stop) try { f(); } catch {} anvil.stop(); }
console.log(fails ? `${fails} FAILURES` : "inventory adoption: all checks passed"); process.exit(fails ? 1 : 0);
