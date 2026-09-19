// A DEPLOYED build, as a visitor meets it. External relayers are not open yet, so a build with VITE_RELAYER_URL baked in
// offers no "which mesh" control: it connects on open, says "online", and lists the brains -- with no click at all.
// And if the relayer is away when the page opens, the page keeps trying and comes online when it is back.
// This test rebuilds frontend/dist with a relayer baked in, and puts the plain build back when it is done.
import { spawnSync } from "node:child_process"; import path from "node:path";
import { chromium } from "playwright";
import * as H from "./harness.mjs"; import { startFrontend } from "../frontend/serve.mjs";
let fails = 0; const check = (n, ok) => { console.log((ok ? "  ok   " : "  FAIL ") + n); if (!ok) fails++; };
const waitFor = async (pred, ms = 30000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await pred()) return true; await H.sleep(200); } return false; };
const API_PORT = 18797; const build = (env) => { const r = spawnSync("npm", ["run", "build:frontend"], { cwd: H.root, env: { ...process.env, ...env }, encoding: "utf8" }); if (r.status !== 0) throw new Error("build failed: " + (r.stderr || r.stdout).slice(-400)); };

H.forgeBuild(); build({ VITE_RELAYER_URL: `http://127.0.0.1:${API_PORT}` });
const anvil = await H.startAnvil(8568); let browser; const stop = [];
try {
  const dep = await H.deployMesh(anvil.rpc); const { mepId } = await H.registerSyntheticMep(dep, H.KEYS[0]);
  const fe = await startFrontend(0); stop.push(() => fe.server.close());
  const launch = { headless: true }; if (process.env.PW_CHROMIUM) launch.executablePath = process.env.PW_CHROMIUM;
  browser = await chromium.launch(launch); const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  // the page opens BEFORE the relayer is up
  await page.goto(fe.url + "/"); await page.waitForFunction(() => window.__ready === true);
  check("there is no Mesh capsule to set, and no arrow to press", !(await page.locator(".where").isVisible()) && !(await page.locator("#btnDep").isVisible()));
  check("with the relayer away it says so and keeps trying, rather than \"offline\"", await waitFor(async () => /retrying|connecting/.test(await page.locator(".pill").innerText())));
  const R = await H.startRelayer(dep, H.KEYS[3], [mepId], { apiPort: API_PORT, env: { PORW_BEACON_LAZY: "1" } }); stop.push(() => R.stop());
  check("when the relayer is there it comes online by itself", await waitFor(async () => (await page.locator(".pill").innerText()).trim() === "online", 40000));
  check("and lists the brains, with no click", await page.evaluate(() => window.app.state.meps.length === 1) && (await page.locator(".listings .brain.listing").count()) === 1);
  check("the controller still reads the relayer's address from the (hidden) field", (await page.evaluate(() => document.getElementById("relayer").value)) === `http://127.0.0.1:${API_PORT}`);
} catch (e) { console.error(e); fails++; }
finally { if (browser) await browser.close(); for (const f of stop) try { f(); } catch {} anvil.stop(); build({ VITE_RELAYER_URL: "" }); }
console.log(fails ? `${fails} FAILURES` : "solo: all checks passed"); process.exit(fails ? 1 : 0);
