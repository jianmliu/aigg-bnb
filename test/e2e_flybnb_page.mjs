// The FlyBnB view in headless Chromium, as a VISITOR: no wallet, nothing signed. The banner is on the home page, the
// view links the paper and the dataset, and the acknowledgments are whoever holds an individual on-chain -- so a
// transfer made behind the page's back shows up the next time the list is read.
import { chromium } from "playwright";
import { parseEther } from "viem";
import * as H from "./harness.mjs";
import { startFrontend } from "../frontend/serve.mjs";
let fails = 0; const check = (n, ok) => { console.log((ok ? "  ok   " : "  FAIL ") + n); if (!ok) fails++; };
const waitFor = async (pred, ms = 20000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await pred()) return true; await H.sleep(200); } return false; };

H.forgeBuild();
const anvil = await H.startAnvil(8564); let browser; const stop = [];
try {
  const dep = await H.deployMesh(anvil.rpc); const { mepId } = await H.registerSyntheticMep(dep, H.KEYS[0]);
  const A = H.clientsFor(dep, H.KEYS[1]), B = H.clientsFor(dep, H.KEYS[2]);
  const C = await H.deployCollection(dep, parseEther("0.002")); await H.adoptBoth(A, C);
  const R = await H.startRelayer(dep, H.KEYS[3], [mepId], { env: { PORW_BEACON_LAZY: "1", PORW_COLLECTION: C, PORW_KEEPER: "0", PORW_TASK_CLIENTS: H.clientsFor(dep, H.KEYS[0]).account.address } }); stop.push(() => R.stop());
  const fe = await startFrontend(0); stop.push(() => fe.server.close());
  const launch = { headless: true }; if (process.env.PW_CHROMIUM) launch.executablePath = process.env.PW_CHROMIUM;
  browser = await chromium.launch(launch); const page = await browser.newPage({ viewport: { width: 1280, height: 900 } }); page.on("console", (m) => { if (m.type() === "error") console.error("page:", m.text()); });
  await page.goto(fe.url); await page.waitForFunction(() => window.__ready === true);
  await page.evaluate((u) => { document.getElementById("relayer").value = u; }, R.apiBase);

  check("the banner is on the home page, above the listings", await page.locator("#flybnbBanner").isVisible() && /FlyBnB/.test(await page.locator("#flybnbBanner").innerText()));
  if (process.env.FLYBNB_SHOTS) await page.screenshot({ path: process.env.FLYBNB_SHOTS + "/home.png" });
  await page.click("#flybnbBanner");
  check("it leads to the FlyBnB view", await waitFor(() => page.locator("#flybnb").isVisible()) && (await page.evaluate(() => location.hash)) === "#/flybnb");
  check("the paper is linked; the dataset says it is in preparation rather than linking nowhere", /paper\.md$/.test(await page.getAttribute("#flybnbPaper", "href")) && /in preparation/.test(await page.locator("#flybnbDataset").innerText()));
  check("a visitor with no wallet sees who holds the individuals", await waitFor(async () => /1 holder · 2 individuals/.test(await page.locator("#flybnbHoldersSummary").innerText().catch(() => ""))));
  const a = A.account.address, b = B.account.address; const short = (x) => `${x.slice(0, 6)}…${x.slice(-4)}`;
  await page.locator("#flybnbHolders summary").click();
  await page.locator("#flybnbHolders .toks").waitFor();
  check("by address, with the tokens held on demand", (await page.locator("#flybnbHolders li").count()) === 1 && (await page.locator("#flybnbHolders").innerText()).includes(short(a)) && /#1 #2/.test(await page.locator("#flybnbHolders").innerText()));

  await H.sendTo(A, C, "FlyCollection", "transferFrom", [a, b, 2n]); await anvil.mine(12);
  await page.click("#navStay"); await page.click("#navFlyBnb"); // the view reads the list when it opens (and every 30 s while open)
  check("after a transfer the acknowledgment has moved with the token", await waitFor(async () => { const t = await page.locator("#flybnbHolders").innerText().catch(() => ""); return /2 holders/.test(await page.locator("#flybnbHoldersSummary").innerText().catch(() => "")) && t.includes(short(a)) && t.includes(short(b)); }));
  if (process.env.FLYBNB_SHOTS) await page.screenshot({ path: process.env.FLYBNB_SHOTS + "/flybnb.png" });

  // third-party experiments are not open yet: the relayer sponsors only the project's tasks, and the page does not offer one
  await page.click("#navStay"); await page.click("#btnDep"); await page.waitForFunction(() => window.app.state.deployment !== null && window.app.state.meps.length > 0);
  check("a visitor is told experiments are not open yet, instead of being offered a booking nothing would run", await waitFor(() => page.locator("#bookingClosed").isVisible()) && (await page.locator("#btnPostTask").count()) === 0 && /FlyBnB atlas needs/.test(await page.locator("#bookingClosed").innerText()));
  if (process.env.FLYBNB_SHOTS) await page.screenshot({ path: process.env.FLYBNB_SHOTS + "/booking-closed.png", fullPage: true });
} catch (e) { console.error(e); fails++; }
finally { if (browser) await browser.close(); for (const s of stop) s(); anvil.stop(); }
console.log(fails ? `${fails} FAILURES` : "flybnb page: all checks passed"); process.exit(fails ? 1 : 0);
