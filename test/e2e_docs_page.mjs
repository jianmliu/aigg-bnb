// The docs view in headless Chromium, as a VISITOR with no wallet.
//
// A documentation page is the easiest place in a project for a number to go stale: somebody changes MINT_PRICE in a
// deploy script and the page still says what it said a year ago, politely and wrongly. So the checks that matter here
// are not that the prose renders -- they are that the page's numbers are THIS deployment's, read from the collection
// and the relayer while the page is open. The test deploys a collection with deliberately odd terms (a price no
// document would have hard-coded, a royalty split 9/1) and requires the page to show those and not the repository's.
//
// The other thing proved is the split the page exists for: the two audiences are one at a time, each reachable by its
// own link, so a player is never made to read a Merkle tree and an engineer is never made to read what a royalty is.
import { chromium } from "playwright";
import { parseEther } from "viem";
import * as H from "./harness.mjs";
import { startFrontend } from "../frontend/serve.mjs";
let fails = 0; const check = (n, ok, note = "") => { console.log((ok ? "  ok   " : "  FAIL ") + n + (ok || !note ? "" : "  " + note)); if (!ok) fails++; };
const waitFor = async (pred, ms = 20000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await pred().catch(() => false)) return true; await H.sleep(200); } return false; };

H.forgeBuild();
const anvil = await H.startAnvil(8566); let browser; const stop = [];
try {
  const dep = await H.deployMesh(anvil.rpc); const { mepId } = await H.registerSyntheticMep(dep, H.KEYS[0]);
  // terms nothing in the repository carries: 0.06 to adopt of which 0.025 is the adopter's own bond, a 10% royalty
  // of which a tenth is the base vendor's -- so the page must say 9% to the owner and 1% to the base, computed.
  const C = await H.deployCollection(dep, parseEther("0.002"), H.KEYS[0], { mintBond: parseEther("0.025"), baseMepFemale: mepId, royaltyBps: 1000, baseShareBps: 1000, baseVendor: "0x00000000000000000000000000000000000ba5ed" });
  const R = await H.startRelayer(dep, H.KEYS[3], [mepId], { env: { PORW_BEACON_LAZY: "1", PORW_COLLECTION: C, PORW_KEEPER: "0" } }); stop.push(() => R.stop());
  const fe = await startFrontend(0); stop.push(() => fe.server.close());

  const launch = { headless: true }; if (process.env.PW_CHROMIUM) launch.executablePath = process.env.PW_CHROMIUM;
  browser = await chromium.launch(launch); const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = []; page.on("console", (m) => { if (m.type() === "error") { errors.push(m.text()); console.error("page:", m.text()); } });
  await page.goto(fe.url); await page.waitForFunction(() => window.__ready === true);
  await page.evaluate((u) => { document.getElementById("relayer").value = u; }, R.apiBase);
  await page.click("#btnDep"); await page.waitForFunction(() => window.app.state.deployment !== null);
  check("nothing has read the collection yet: the docs page is what asks for it", await page.evaluate(() => window.app.state.flyTerms === null));

  // ---- getting there ----
  await page.click("#navDocs");
  await page.waitForFunction(() => window.app.state.flyTerms !== null); // the view reads the terms when it opens
  check("the nav leads to the docs view", await waitFor(() => page.locator("#docs").isVisible()) && (await page.evaluate(() => location.hash)) === "#/docs");
  check("a visitor with no wallet sees it", await page.evaluate(() => window.app.state.wallet === null));
  check("it opens on the player's half, not the protocol's", await page.locator("#docsPlay").isVisible() && (await page.locator("#docsHow").count()) === 0);

  // ---- the numbers are this deployment's ----
  const costs = async () => page.locator("#docsCosts").innerText();
  check("the adoption price is the collection's, to the digit", await waitFor(async () => /0\.06 BNB/.test(await costs())), await costs().catch(() => ""));
  check("and the part of it that stays the adopter's own bond", /0\.025 BNB/.test(await costs()));
  check("the breeding fee is the collection's", /0\.01 BNB/.test(await costs()));
  check("the owner's share is the royalty less the base vendor's, computed and not asserted: 9%", /\b9%/.test(await costs()) && /\b1%/.test(await costs()));
  check("nothing is shown as a bare wei figure", !/\d{10}/.test(await costs()));
  // the page must follow the chain, not a build: change the terms the only way they can change (a new collection) and
  // the page reads the new ones. A hard-coded number would survive this; a read cannot.
  const C2 = await H.deployCollection(dep, parseEther("0.002"), H.KEYS[0], { mintPrice: parseEther("0.09"), mintBond: parseEther("0.025"), baseMepFemale: mepId, royaltyBps: 1000, baseShareBps: 1000, baseVendor: "0x00000000000000000000000000000000000ba5ed" });
  await page.evaluate((addr) => { window.app.state.deployment.addresses.collection = addr; }, C2);
  await page.evaluate(() => { window.app.state.flyTerms = null; return window.appActions.loadTerms(); });
  check("a different collection gives different prices on the same page", await waitFor(async () => /0\.09 BNB/.test(await costs())), await costs().catch(() => ""));

  // ---- rarity: the one claim the page is not allowed to invent ----
  const play = await page.locator("#docsPlay").innerText();
  check("rarity is stated as a measurement, not a table handed out at mint", /measurement/i.test(play) && /no\b[\s\S]{0,40}rarity|not measured yet/i.test(play));
  check("it says what is unknown about a fly just bred, rather than showing it a score", /bred a minute ago|not measured yet/i.test(play));
  check("the founders are the comparison, and there are a hundred of them", /hundred founders/.test(play));
  check("it does not promise what an individual will earn", !/guarantee|you will earn|profit/i.test(play) && /earn close to nothing/.test(play));

  // ---- the technical half ----
  await page.click("#docsTabHow");
  check("the tab switches to the protocol half and the player half goes away", await waitFor(() => page.locator("#docsHow").isVisible()) && (await page.locator("#docsPlay").count()) === 0);
  check("the hash follows, so either half can be linked to", (await page.evaluate(() => location.hash)) === "#/docs/how");
  const how = await page.locator("#docsHow").innerText();
  check("it names the market and the instance registry of THIS deployment", (await page.locator("#docsDeployment").innerText()).includes(dep.addresses.market) && (await page.locator("#docsDeployment").innerText()).includes(dep.addresses.instances));
  check("the determinism claim is the one the protocol actually rests on", /integer/i.test(how) && /order-independent/i.test(how) && /cannot verify an LLM/i.test(how));
  check("the three names are distinguished: the protocol, the deployment, the dataset", /aigg-bnb/.test(how) && /FlyBnB/.test(how) && /a dataset/.test(how));
  check("the billing unit is stated as one unit at one rate", /token is a fixed amount of work/i.test(how) && /9\.4×/.test(how));

  // a deep link lands on the technical half without passing through the player's
  const p2 = await browser.newPage(); await p2.goto(fe.url + "#/docs/how"); await p2.waitForFunction(() => window.__ready === true);
  check("a link straight to #/docs/how opens there", await waitFor(() => p2.locator("#docsHow").isVisible()) && (await p2.locator("#docsPlay").count()) === 0);
  await p2.close();

  check("no page errors while all this happened", errors.length === 0, errors.join(" | "));
  if (process.env.FLYBNB_SHOTS) { await page.click("#docsTabPlay"); await page.screenshot({ path: process.env.FLYBNB_SHOTS + "/docs.png", fullPage: true }); }
} catch (e) { console.error(e); fails++; }
finally { if (browser) await browser.close(); for (const s of stop) s(); anvil.stop(); }
console.log(fails ? `${fails} FAILURES` : "docs page: all checks passed"); process.exit(fails ? 1 : 0);
