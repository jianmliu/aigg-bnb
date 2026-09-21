// The Flies view in headless Chromium: the colony, the pairing, and the egg.
//
// The thing worth proving is the egg. `breed` fixes a recipe and a seed block; one block later the PAGE computes
// what the child will be from that block's hash, before anything on-chain says so -- so the check that matters is
// that the page's preview and FlyCollection.hatch agree to the bit, whoever ends up calling hatch: the page's own
// button (no keeper running), the relayer's keeper (the page sends nothing and notices), and after an expiry, a
// re-armed seed block, which is a different draw. The wallet is simulated outside the page, as in e2e_frontend.
import { chromium } from "playwright";
import { parseEther } from "viem";
import * as H from "./harness.mjs";
import { startFrontend } from "../frontend/serve.mjs";
let fails = 0; const check = (n, ok) => { console.log((ok ? "  ok   " : "  FAIL ") + n); if (!ok) fails++; };
const waitFor = async (pred, ms = 30000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await pred()) return true; await H.sleep(200); } return false; };
const ZERO32 = "0x" + "0".repeat(64);

H.forgeBuild();
const anvil = await H.startAnvil(8562); let browser; const stop = [];
try {
  const dep = await H.deployMesh(anvil.rpc,H.KEYS[0],"MultiAssetTaskMarket"); const { mepId } = await H.registerSyntheticMep(dep, H.KEYS[0]);
  const W = H.clientsFor(dep, H.KEYS[1]); // the wallet behind the page
  const C = await H.deployCollection(dep, parseEther("0.002")); await H.adoptBoth(W, C);
  const factory=await H.create(H.clientsFor(dep,H.KEYS[0]),"BatteryBudget",[C,dep.addresses.market,H.clientsFor(dep,H.KEYS[4]).account.address,{versionHash:"0x"+"11".repeat(32),runsRoot:"0x"+"22".repeat(32),runs:39,steps:5000,stride:500,redundancy:2,attempts:2,fee:parseEther("0.01"),lifetime:86400}]);
  const admin=H.clientsFor(dep,H.KEYS[0]);const token=await H.create(admin,"TestToken");const router=await H.create(admin,"TestSwapRouter",[token]);
  await H.sendTo(admin,dep.addresses.market,"MultiAssetTaskMarket","setTokenAllowed",[token,true]);
  await H.sendTo(admin,token,"TestToken","mint",[router,parseEther("1")]);
  const tokenFactory=await H.create(admin,"TokenBatteryBudget",[C,dep.addresses.market,H.clientsFor(dep,H.KEYS[4]).account.address,{versionHash:"0x"+"11".repeat(32),runsRoot:"0x"+"22".repeat(32),runs:39,steps:5000,stride:500,redundancy:2,attempts:2,fee:parseEther("0.01"),lifetime:86400},token,router]);
  const onChain = async (id) => { const x = await H.readFrom(W, C, "FlyCollection", "individuals", [BigInt(id)]); return { sex: Number(x[4]), seed: x[8], seedBlock: Number(x[9]) }; };
  // names the collection to the page, hatches nothing: the first egg is the page's to hatch
  const R = await H.startRelayer(dep, H.KEYS[3], [mepId], { env: { PORW_BEACON_LAZY: "1", PORW_COLLECTION: C, PORW_BATTERY_BUDGET: factory, PORW_TOKEN_BATTERY_BUDGET: tokenFactory, PORW_KEEPER: "0" } }); stop.push(() => R.stop());
  const fe = await startFrontend(0); stop.push(() => fe.server.close());

  const prompts = [];
  const launch = { headless: true }; if (process.env.PW_CHROMIUM) launch.executablePath = process.env.PW_CHROMIUM;
  browser = await chromium.launch(launch); const page = await browser.newPage(); page.on("console", (m) => { if (m.type() === "error") console.error("page:", m.text()); });
  await page.exposeFunction("__walletRequest", async (method, params) => {
    switch (method) {
      case "eth_requestAccounts": case "eth_accounts": return [W.account.address];
      case "eth_chainId": return "0x" + dep.chainId.toString(16);
      case "eth_call": return W.pub.call({ to: params[0].to, data: params[0].data }).then((r) => r.data || "0x");
      case "eth_getBalance": return "0x" + (await W.pub.getBalance({ address: params[0] })).toString(16);
      case "eth_blockNumber": return "0x" + (await W.pub.getBlockNumber()).toString(16);
      case "eth_getBlockByNumber": return W.pub.request({method,params});
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
  // Another extension may replace the global after connection. Breed approvals and host asset opt-in
  // must continue using the provider selected by the wallet controller.
  await page.evaluate(() => { window.ethereum = { request: async () => { throw new Error("wrong wallet provider"); } }; });


  check("on a mesh that names no task clients (a local one) the booking card is open", (await page.locator("#btnPostTask").count()) === 1 && (await page.locator("#bookingClosed").count()) === 0);
  // ---- the colony ----
  await page.click("#navFlies"); await page.click("#btnFlies"); await page.waitForFunction(() => window.app.state.flies && window.app.state.flies.all.length === 2);
  check("the node console is hidden, not gone: the controller still has its #log", await page.evaluate(() => !!document.getElementById("log") && document.getElementById("log").offsetParent === null));
  check("the colony shows both adopted flies as this wallet's, one of each sex", await page.evaluate(() => { const a = window.app.state.flies.all; return a.every((f) => f.mine) && a[0].sex === 0 && a[1].sex === 1; }));
  check("the pairing starts empty and says what it needs", (await page.textContent("#breedProblem")) === "choose one female and one male" && await page.isDisabled("#btnBreed"));
  await page.click("#btnGenesis");
  check("without a configured treasury sale no adoption is offered", await waitFor(() => page.evaluate(() => !!window.app.state.flies?.sale?.unavailable)) && (await page.locator("#adoptable .listing").count()) === 0);
  const pair = async () => { await page.click("#fly-1"); await page.click("#fly-2"); };
  await pair();
  check("clicking a fly puts it in the slot for its sex", /#1 ♀/.test(await page.textContent("#slotDam")) && /#2 ♂/.test(await page.textContent("#slotSire")) && (await page.textContent("#breedProblem")) === "ready");
  check("the page says which base the child will vary, before the transaction", /female base/.test(await page.textContent("#breedBase")));
  const fee = await page.textContent("#breedFee");
  check("the fee is shown as what it buys: 0.01 = 0.002 bounty + 0.008 treasury", /breed fee\s*0\.01 BNB/.test(fee) && /hatch bounty\s*0\.002 BNB/.test(fee) && /treasury\s*0\.008 BNB/.test(fee));

  // ---- an egg the page hatches itself ----
  const eggOf = (id) => page.evaluate((i) => { const f = window.app.state.flies.all.find((x) => x.id === i); return f ? { seed: f.seed, sex: f.sex, seedBlock: f.seedBlock, preview: f.preview } : null; }, id);
  await page.click("#btnBreed"); await page.waitForFunction(() => window.app.state.flies.all.length === 3, null, { timeout: 60000 });
  const escrow=await H.readFrom(W,factory,"BatteryBudget","jobOf",[3n]);
  check("breed locks its separate battery budget",await W.pub.getBalance({address:escrow})===parseEther("0.02"));
  let egg = await eggOf(3);
  check("breeding produced an egg: no seed, no sex, a seed block", egg.seed === ZERO32 && egg.sex === 2 && egg.seedBlock === (await onChain(3)).seedBlock && egg.preview === null);
  await page.waitForFunction(()=>document.getElementById("slotDam").textContent.includes("—"));
  check("the slots empty again, and an egg cannot be picked for the pairing", /—/.test(await page.textContent("#slotDam")) && await page.evaluate(() => document.getElementById("fly-3").getAttribute("role") === null));
  check("the Hatch button waits for the seed block", await page.isDisabled("#btnHatch-3"));
  await anvil.mine(2);
  check("a block later the page knows what the child will be", await waitFor(async () => (await eggOf(3)).preview !== null));
  egg = await eggOf(3); const h3 = (await W.pub.getBlock({ blockNumber: BigInt(egg.seedBlock) })).hash;
  check("and its arithmetic is the contract's: keccak(recipe, blockhash(seedBlock))", egg.preview.seed === H.flySeed(3, h3) && egg.preview.sex === Number(BigInt(egg.preview.seed) & 1n));
  check("nothing is on-chain yet: nobody is running a keeper", (await onChain(3)).seed === ZERO32);
  await page.click("#btnHatch-3"); await page.waitForFunction(() => window.app.state.flies.all.find((x) => x.id === 3).seed !== "0x" + "0".repeat(64), null, { timeout: 60000 });
  const c3 = await onChain(3);
  check("hatched from the page: the chain agrees with the preview, seed and sex", c3.seed === egg.preview.seed && c3.sex === egg.preview.sex);
  check("the hatched child is unborn, and still cannot breed", await waitFor(async () => /unborn/.test(await page.textContent("#fly-3")) && await page.evaluate(() => document.getElementById("fly-3").getAttribute("role") === null)));

  // ---- an egg the keeper hatches: the page sends nothing and notices ----
  const K = await H.startRelayer(dep, H.KEYS[2], [mepId], { env: { PORW_BEACON_LAZY: "1", PORW_COLLECTION: C } }); stop.push(() => K.stop());
  await pair(); await page.click("#btnBreed"); await page.waitForFunction(() => window.app.state.flies.all.length === 4, null, { timeout: 60000 });
  const sent = prompts.length; await anvil.mine(2);
  check("the keeper hatched it and the page saw it happen", await waitFor(async () => (await eggOf(4)).seed !== ZERO32));
  check("without a wallet prompt, and as the chain has it", prompts.length === sent && (await eggOf(4)).seed === (await onChain(4)).seed && (await eggOf(4)).sex === (await onChain(4)).sex);
  K.stop(); await H.sleep(500);

  // ---- an egg nobody hatches: 256 blocks later it needs re-arming, and a new block is a new draw ----
  await pair(); await page.click("#btnBreed"); await page.waitForFunction(() => window.app.state.flies.all.length === 5, null, { timeout: 60000 });
  const first = (await eggOf(5)).seedBlock; await anvil.mine(260);
  check("after the window the page offers Re-arm instead of Hatch", await waitFor(async () => (await page.$("#btnRearm-5")) !== null) && (await page.$("#btnHatch-5")) === null);
  const treasuryBefore = await W.pub.getBalance({ address: H.FLY_TREASURY });
  await page.click("#btnRearm-5"); await page.waitForFunction((b) => window.app.state.flies.all.find((x) => x.id === 5).seedBlock > b, first, { timeout: 60000 });
  check("re-arming cost a whole breed fee, all of it to the treasury", (await W.pub.getBalance({ address: H.FLY_TREASURY })) - treasuryBefore === H.FLY_BREED_FEE);
  await anvil.mine(2);
  check("the re-armed egg gets a fresh preview from its new seed block", await waitFor(async () => { const e = await eggOf(5); return e.preview !== null && e.seedBlock > first; }));
  egg = await eggOf(5); const h5 = (await W.pub.getBlock({ blockNumber: BigInt(egg.seedBlock) })).hash;
  check("which is again the contract's arithmetic", egg.preview.seed === H.flySeed(5, h5));
  await page.click("#btnHatch-5"); await page.waitForFunction(() => window.app.state.flies.all.find((x) => x.id === 5).seed !== "0x" + "0".repeat(64), null, { timeout: 60000 });
  check("and hatches to it", (await onChain(5)).seed === egg.preview.seed);
  check(`the wallet was prompted for exactly: 3 breeds, 2 hatches, 1 re-arm (${prompts.length})`, prompts.length === 8);
  await page.selectOption('#batteryRoute','token');await page.waitForFunction(()=>window.app.state.flies.battery?.tokenMode===true);
  await pair();check('token route requires a reviewed BNB quote',await page.isDisabled('#btnBreed'));
  await page.click('#btnBatteryQuote');await page.waitForFunction(()=>!!window.app.state.flies.battery?.quote);
  await page.click('#btnBreed');await page.waitForFunction(()=>window.app.state.flies.all.length===6,null,{timeout:60000});
  const tokenJob=await H.readFrom(W,tokenFactory,'TokenBatteryBudget','jobOf',[6n]);
  check('BNB checkout creates token-funded child',await H.readFrom(W,token,'TestToken','balanceOf',[tokenJob])===parseEther('0.02'));
  check('token refund denomination is visible',/AIGG/.test(await page.textContent('#batteryQuote')));
  await page.selectOption('#batteryRoute','native');await page.waitForFunction(()=>window.app.state.flies.battery?.tokenMode===false);
  check('native route and its existing jobs remain available',await page.evaluate(()=>!!window.app.state.flies.battery.jobs[3]));
  // The configured branch is what every assertion above exercises. What ships on BSC testnet is the OTHER one --
  // no battery budget at all -- and it used to render "not funded" once per fly beneath a line saying funding was
  // unavailable. Drive the page into that state and check it says whose state it is.
  { check('with a queue, a fly without a job is told so per fly', /not funded/.test(await page.textContent('body')));
    // take the queue away the way a deployment without one has it: no address, then re-read
    await page.evaluate(async () => { window.__bb = window.app.state.deployment.addresses.batteryBudget; window.app.state.deployment.addresses.batteryBudget = null; await window.appActions.loadBattery(); });
    await page.waitForSelector('#batteryQueueState', { timeout: 30000 });
    const text = await page.textContent('body');
    check('without one, the page stops claiming it about every fly', !/not funded/.test(text));
    check('  and says it is the deployment that has no queue', /no experiment can be funded here yet/i.test(text) && /not a state of any individual fly/i.test(text));
    await page.evaluate(async () => { window.app.state.deployment.addresses.batteryBudget = window.__bb; await window.appActions.loadBattery(); });
    await page.waitForFunction(() => !!window.app.state.flies.battery?.address, null, { timeout: 30000 });
    check('  and it comes back when the queue is read again', /not funded/.test(await page.textContent('body'))); }
  await page.click('#navHost');await page.getByRole('button',{name:'Accept AIGG tasks',exact:true}).click();
  check('host explicitly opts in to AIGG',await waitFor(async()=>await H.readFrom(W,dep.addresses.market,'MultiAssetTaskMarket','acceptedToken',[W.account.address,token])));
  await page.getByRole('button',{name:'Stop accepting new AIGG tasks',exact:true}).click();
  check('host can stop new AIGG assignments',await waitFor(async()=>!await H.readFrom(W,dep.addresses.market,'MultiAssetTaskMarket','acceptedToken',[W.account.address,token])));
  console.log("page log tail:\n" + (await page.evaluate(() => document.getElementById("log").textContent)).split("\n").slice(-6).join("\n"));
} catch (e) { console.error(e); fails++; } finally { if (browser) await browser.close(); for (const f of stop) try { f(); } catch {} anvil.stop(); }
console.log(fails ? `${fails} FAILURES` : "flies: all checks passed"); process.exit(fails ? 1 : 0);
