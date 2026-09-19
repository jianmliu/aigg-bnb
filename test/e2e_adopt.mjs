// Adoption through the page, against the REAL genesis set (flybnb/genesis/genesis-v1.json: the pilot's hundred
// founders). The page ships the set, offers it only because its root is the collection's GENESIS_ROOT, and adopts with
// the published proof. One transaction at one price: the adopter comes out owning the individual AND bonded for the
// base brain (InstanceRegistry.bondFor), and the rest goes to the treasury. The royalty line says what the collection's
// terms are. (Royalties accruing and being settled is FlyCollectionRoyalty.t.sol's; it needs settled tasks.)
import fs from "node:fs"; import path from "node:path";
import { chromium } from "playwright"; import { parseEther } from "viem";
import * as H from "./harness.mjs"; import { startFrontend } from "../frontend/serve.mjs";
let fails = 0; const check = (n, ok) => { console.log((ok ? "  ok   " : "  FAIL ") + n); if (!ok) fails++; };
const waitFor = async (pred, ms = 30000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await pred()) return true; await H.sleep(200); } return false; };
const G = JSON.parse(fs.readFileSync(path.join(H.root, "flybnb/genesis/genesis-v1.json"), "utf8"));

H.forgeBuild();
const anvil = await H.startAnvil(8567); let browser; const stop = [];
try {
  const dep = await H.deployMesh(anvil.rpc); const base = await H.registerSyntheticMep(dep, H.KEYS[0], { name: "base-female" });
  const W = H.clientsFor(dep, H.KEYS[1]); const PRICE = parseEther("0.1"), BOND = parseEther("0.05"); // harness UNIT is 0.05: one vote
  const C = await H.deployCollection(dep, 0n, H.KEYS[0], { genesis: G, baseMepFemale: base.mepId, royaltyBps: 1000, mintPrice: PRICE, mintBond: BOND });
  const R = await H.startRelayer(dep, H.KEYS[3], [base.mepId], { env: { PORW_BEACON_LAZY: "1", PORW_COLLECTION: C, PORW_KEEPER: "0" } }); stop.push(() => R.stop());
  const fe = await startFrontend(0); stop.push(() => fe.server.close()); const prompts = [];
  const launch = { headless: true }; if (process.env.PW_CHROMIUM) launch.executablePath = process.env.PW_CHROMIUM;
  browser = await chromium.launch(launch); const page = await browser.newPage({ viewport: { width: 1280, height: 900 } }); page.on("console", (m) => { if (m.type() === "error") console.error("page:", m.text()); });
  await page.exposeFunction("__walletRequest", async (method, params) => {
    switch (method) {
      case "eth_requestAccounts": case "eth_accounts": return [W.account.address];
      case "eth_chainId": return "0x" + dep.chainId.toString(16);
      case "eth_call": return W.pub.call({ to: params[0].to, data: params[0].data }).then((r) => r.data || "0x");
      case "eth_getBalance": return "0x" + (await W.pub.getBalance({ address: params[0] })).toString(16);
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

  const fee = await page.locator("#adoptFee").innerText();
  check("the price is shown as what it buys: 0.1 = 0.05 your bond + 0.05 treasury", /adoption\s*0\.1 BNB/.test(fee) && /your bond\s*0\.05 BNB/.test(fee) && /treasury\s*0\.05 BNB/.test(fee));
  check("and the royalty as the collection's terms: 10%", /10% of every fee/.test(await page.locator("#owed").innerText()) && await page.isDisabled("#btnWithdraw"));
  await page.click("#btnGenesis");
  check("the page's genesis set is this collection's, and all hundred founders are open", await waitFor(() => page.evaluate(() => window.app.state.flies.genesis?.matches === true && window.app.state.flies.genesis.open.length === 100)));
  check("twelve are shown, each adoptable", (await page.locator("#adoptable .brain.listing").count()) === 12 && await page.isEnabled("#btnAdopt-0"));
  if (process.env.FLYBNB_SHOTS) await page.screenshot({ path: process.env.FLYBNB_SHOTS + "/adopt.png", fullPage: true });

  const treasury = await W.pub.getBalance({ address: H.FLY_TREASURY });
  await page.click("#btnAdopt-0"); await page.waitForFunction(() => window.app.state.flies.all.length === 1, null, { timeout: 60000 });
  const ind = await H.readFrom(W, C, "FlyCollection", "individuals", [1n]);
  check("adopted with the published proof: the token is the wallet's and carries founder #0's delta", (await H.readFrom(W, C, "FlyCollection", "ownerOf", [1n])).toLowerCase() === W.account.address.toLowerCase() && ind[1] === G.individuals[0].deltaHash && ind[0] === G.baseModelId);
  check("one transaction, and the adopter is now a bonded host of the base brain", prompts.length === 1 && (await W.instances.read.bonded([W.account.address])) === BOND && (await W.instances.read.isBondedFor([W.account.address, base.mepId])));
  check("the rest went to the treasury", (await W.pub.getBalance({ address: H.FLY_TREASURY })) - treasury === PRICE - BOND);
  check("the colony shows it as yours, and 99 founders are left", await page.evaluate(() => window.app.state.flies.all[0].mine === true) && await waitFor(() => page.evaluate(() => window.app.state.flies.genesis.open.length === 99)) && (await page.locator("#btnAdopt-0").count()) === 0);
  const again = await page.evaluate(async () => { try { await window.appActions.adopt(0); return null; } catch (e) { return e.message; } });
  check(`a founder is adopted once (${again})`, /not open for adoption/.test(again || ""));
} catch (e) { console.error(e); fails++; } finally { if (browser) await browser.close(); for (const f of stop) try { f(); } catch {} anvil.stop(); }
console.log(fails ? `${fails} FAILURES` : "adopt: all checks passed"); process.exit(fails ? 1 : 0);
