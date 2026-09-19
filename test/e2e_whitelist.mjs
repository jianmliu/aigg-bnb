// The brains a relayer serves follow the whitelist. The whitelist is of COLLECTIONS (CollectionWhitelist); for every
// listed collection the relayer serves the bases it names and every brain bound to one of its tokens. So:
//   - it starts with no PORW_MEP_IDS at all, and serves the listed collection's base brain;
//   - a fly is served from the pass after its owner registers it, and so is a BRED one, with nothing restarted;
//   - a collection with a royalty registers its flies under terms, and the relayer reproduces that id too;
//   - the same code deployed by somebody else, and a MEP registered with no collection, are never served --
//     until the curator lists the collection, and again once it is taken off;
// The mesh is deployed from the build artifacts (no ExecutionDisputes: nothing here reaches it).
import { keccak256 } from "viem";
import * as H from "./harness.mjs";
let fails = 0; const check = (n, ok) => { console.log((ok ? "  ok   " : "  FAIL ") + n); if (!ok) fails++; };
const waitFor = async (p, ms = 20000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await p()) return true; await H.sleep(150); } return false; };

H.forgeBuild();
const anvil = await H.startAnvil(8566); const stop = [];
try {
  const dep = await H.deployMesh(anvil.rpc); const D = H.clientsFor(dep, H.KEYS[0]); const owner = H.clientsFor(dep, H.KEYS[1]); const stranger = H.clientsFor(dep, H.KEYS[2]);
  const base = await H.registerSyntheticMep(dep, H.KEYS[0], { name: "base-female" });
  const W = await H.create(D, "CollectionWhitelist", [D.account.address]); dep.addresses.whitelist = W;
  const ours = await H.deployCollection(dep, 0n, H.KEYS[0], { baseMepFemale: base.mepId });
  await H.sendTo(D, W, "CollectionWhitelist", "add", [ours, "the genesis collection"]);

  // no PORW_MEP_IDS: everything it serves comes from the list. A pass every 2 blocks, so the test does not wait on it
  const R = await H.startRelayer(dep, H.KEYS[3], [], { env: { PORW_BEACON_LAZY: "1", PORW_WHITELIST: W, PORW_WHITELIST_EVERY: "2" } }); stop.push(() => R.stop());
  const served = async () => (await R.api("/meps")).map((m) => m.mepId);
  const tick = () => anvil.mine(3);
  const servedSoon = async (id) => { await tick(); return waitFor(async () => { await tick(); return (await served()).includes(id.toLowerCase()); }); };
  const neverServed = async (id) => { for (let i = 0; i < 6; i++) { await tick(); await H.sleep(350); if ((await served()).includes(id.toLowerCase())) return false; } return true; };

  check("/deployment names the whitelist", ((await R.api("/deployment")).addresses.whitelist || "").toLowerCase() === W.toLowerCase());
  check("with no PORW_MEP_IDS it serves the listed collection's base brain", await servedSoon(base.mepId));
  const b = (await R.api("/meps")).find((m) => m.mepId === base.mepId.toLowerCase());
  check(`and says where it comes from (${b && b.name}, token ${b && b.token})`, !!b && b.collection === ours.toLowerCase() && b.token === null && b.royaltyBps === 0);

  // ---- an adopted fly, then a bred one: served once registered, nothing restarted ----
  await H.adoptBoth(owner, ours);
  const F = await H.syntheticMep({ name: "fly-1", neurons: 3000, synapses: 30000 }), M = await H.syntheticMep({ name: "fly-2", neurons: 3200, synapses: 31000 });
  check("an adopted fly that is not registered has no MEP, so there is nothing to serve", (await served()).length === 1);
  await H.sendTo(owner, ours, "FlyCollection", "register", [1n, H.GENESIS.DF, F.fields]);
  check("registered: the relayer serves it from the next pass", await servedSoon(F.mepId));
  const f = (await R.api("/meps")).find((m) => m.mepId === F.mepId.toLowerCase());
  check(`as that collection's token (${f && f.name})`, !!f && f.token === 1 && f.collection === ours.toLowerCase() && f.neurons === 3000);
  await H.sendTo(owner, ours, "FlyCollection", "register", [2n, H.GENESIS.DM, M.fields]);
  await H.sendTo(owner, ours, "FlyCollection", "breed", [1n, 2n], H.FLY_BREED_FEE); await anvil.mine(2);
  await H.sendTo(owner, ours, "FlyCollection", "hatch", [3n]);
  const K = await H.syntheticMep({ name: "fly-3-bred", neurons: 3100, synapses: 30500 });
  await H.sendTo(owner, ours, "FlyCollection", "register", [3n, keccak256("0x03"), K.fields]);
  check("a BRED fly is served the same way: it is a token of a listed collection, and nobody approved it", await servedSoon(K.mepId));

  // ---- outside the list ----
  const loose = await H.registerSyntheticMep(dep, H.KEYS[2], { name: "no-collection", neurons: 2900, synapses: 29000 });
  const theirs = await H.deployCollection(dep, 0n, H.KEYS[2]); await H.adoptBoth(stranger, theirs);
  const T = await H.syntheticMep({ name: "their-fly", neurons: 2800, synapses: 28000 });
  await H.sendTo(stranger, theirs, "FlyCollection", "register", [1n, H.GENESIS.DF, T.fields]);
  check("a MEP registered with no collection is never served", await neverServed(loose.mepId));
  check("nor is a fly of a collection somebody deployed for themselves", !(await served()).includes(T.mepId.toLowerCase()));

  // ---- the curator lists the other collection, then takes it off ----
  await H.sendTo(D, W, "CollectionWhitelist", "add", [theirs, "recognised after all"]);
  check("listed by the curator: its fly is served", await servedSoon(T.mepId));
  await H.sendTo(D, W, "CollectionWhitelist", "remove", [theirs, "for the test"]);
  check("taken off the list: no longer served", await waitFor(async () => { await tick(); return !(await served()).includes(T.mepId.toLowerCase()); }));
  { const now = await served(); check("and the first collection's brains were not disturbed", [base.mepId, F.mepId, M.mepId, K.mepId].every((id) => now.includes(id.toLowerCase())) && now.length === 4); }

  // ---- a collection with a royalty: the fly's MEP is the profile UNDER TERMS, and the relayer reproduces that id ----
  const royal = await H.deployCollection(dep, 0n, H.KEYS[0], { royaltyBps: 500 }); await H.adoptBoth(owner, royal);
  await H.sendTo(D, W, "CollectionWhitelist", "add", [royal, "with a 5% royalty"]);
  const Rf = await H.syntheticMep({ name: "royal-fly", neurons: 2700, synapses: 27000 });
  await H.sendTo(owner, royal, "FlyCollection", "register", [1n, H.GENESIS.DF, Rf.fields]);
  const termsId = (await H.readFrom(D, royal, "FlyCollection", "individuals", [1n]))[3].toLowerCase();
  check("under a royalty the fly's id is not the plain profile's", termsId !== Rf.mepId.toLowerCase());
  check("the relayer serves it under that id", await servedSoon(termsId));
  const rf = (await R.api("/meps")).find((m) => m.mepId === termsId);
  check(`and reports the terms it found on-chain (${rf && rf.royaltyBps} bps to ${rf && String(rf.beneficiary).slice(0, 10)}…)`, !!rf && rf.royaltyBps === 500 && rf.beneficiary.toLowerCase() === royal.toLowerCase());
  check("while the plain profile of the same bytes, which nobody listed, is not served", !(await served()).includes(Rf.mepId.toLowerCase()));

  const st = await R.api("/status");
  check(`/status.whitelist: ${st.whitelist.collections.length} collections, ${st.whitelist.served} brains, nothing skipped, no whitelist errors`, st.whitelist.collections.length === 2 && st.whitelist.served === 5 && st.whitelist.skipped.length === 0 && !st.errors.some((x) => x.label === "whitelist"));
} catch (e) { console.error(e); fails++; }
finally { for (const f of stop) try { f(); } catch {} anvil.stop(); }
console.log(fails ? `${fails} FAILURES` : "whitelist: all checks passed"); process.exit(fails ? 1 : 0);
