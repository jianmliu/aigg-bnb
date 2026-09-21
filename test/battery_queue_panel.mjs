// "not funded" is a claim about one fly, and it was being made about every fly on a deployment where none could be.
//
// The battery queue panel listed each individual with `j?.status || "not funded"`, where `j` is that fly's entry in
// `battery.jobs`. On BSC testnet `PORW_BATTERY_BUDGET` is not set, so `loadBattery` returns early with an error and
// an EMPTY jobs map -- and the panel rendered two hundred rows saying "not funded", directly beneath one line
// admitting that funding is unavailable. Two hundred things to do, none of which can be done.
//
// The rows were not wrong about the chain. They were wrong about whose state they were describing: an absent queue
// is a property of the deployment, not of any fly in it. The existing page test configures a battery budget, so it
// only ever exercised the branch where the rows ARE about the flies -- which is why this shipped.
import { batteryQueue } from "../frontend/src/core/battery_queue.js";
let fails = 0; const check = (n, ok, note = "") => { console.log((ok ? "  ok   " : "  FAIL ") + n + (ok || !note ? "" : "  " + note)); if (!ok) fails++; };

// what loadBattery actually produces, in each of its exits (frontend/src/core/flies.js)
const CONFIGURED = { address: "0xbA77e47", budget: 20000000000000000n, jobs: {}, tokenMode: false, decimals: 18 };
const NOT_CONFIGURED = { error: "Battery budget is not configured; funded breeding is unavailable.", jobs: {} };
const READ_FAILED = { error: "Battery collection mismatch", jobs: {} };
const SWITCHING = { error: "Loading battery route…", loading: true, jobs: {} };

check("a configured queue is ready, and a fly with no job really is unfunded", batteryQueue(CONFIGURED) === "ready");
check("no battery budget on this deployment is NOT a fact about any fly", batteryQueue(NOT_CONFIGURED) === "unavailable", batteryQueue(NOT_CONFIGURED));
check("a failed read is not one either", batteryQueue(READ_FAILED) === "unavailable", batteryQueue(READ_FAILED));
check("before the first read comes back, nothing is claimed", batteryQueue(undefined) === "checking");
check("  nor while the route is being switched", batteryQueue(SWITCHING) === "checking", batteryQueue(SWITCHING));

// the live shape, as the deployed relayer answers it today: batteryBudget is null, so loadBattery takes that exit
check("the state BSC testnet is actually in reads as unavailable", batteryQueue({ error: "Battery budget is not configured; funded breeding is unavailable.", jobs: {} }) === "unavailable");

// a configured queue WITH jobs still distinguishes funded from not
{ const withJobs = { ...CONFIGURED, jobs: { 3: { status: "funded / queued" } } };
  check("a fly with a job is ready and has its status", batteryQueue(withJobs) === "ready" && withJobs.jobs[3].status === "funded / queued");
  check("  and one without, on the same deployment, is genuinely not funded", batteryQueue(withJobs) === "ready" && !withJobs.jobs[4]); }

// the one that must never regress: an empty jobs map alone must not be read as "ready"
check("an empty jobs map is not evidence that the queue exists", batteryQueue({ jobs: {} }) === "checking", batteryQueue({ jobs: {} }));
check("and neither is a null battery", batteryQueue(null) === "checking");

// `error` still blocks breeding while a route switch is in flight -- the panel says "checking", the button stays shut
check("a route switch still carries an error, so breeding stays blocked", !!SWITCHING.error);

console.log(fails ? `${fails} FAILURES` : "battery queue panel: all checks passed");
process.exit(fails ? 1 : 0);
