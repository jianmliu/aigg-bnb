// The read quota, in the unit this mesh spends it in.
//
// A Greenfield bucket is created with `chargedReadQuota: 0` and lives on a one-off free allowance. Every host that
// joins downloads the whole base before it can serve anything, so the allowance falls by tens of megabytes per host
// and then reads stop: the SP answers 406 `bucket quota overflow`, and to a browser tab that looks like a brain
// which never finishes loading. It happened here, mid-verification, on ordinary use -- a handful of hosts starting
// up over an afternoon spent 1.03 GB.
//
// What was missing was not the quota. It was that nobody could see it: there was no way to ask how much was left
// short of downloading something and watching it fail. So the arithmetic is a function, and it is checked.
import { quotaSummary } from "../js/greenfield_admin.mjs";
let fails = 0; const check = (n, ok, note = "") => { console.log((ok ? "  ok   " : "  FAIL ") + n + (ok || !note ? "" : "  " + note)); if (!ok) fails++; };
const MB = 1024 ** 2, GB = 1024 ** 3, BASE = 77074432; // the founders' base, as published

// the shape the SP actually answered with, the day the quota ran out
const live = { readQuota: 0, freeQuota: 44126358, consumedQuota: 0, freeConsumedSize: 1029615466, monthlyFreeQuota: 0 };
{ const s = quotaSummary(live, BASE);
  check("it reports what is left, not what was bought", s.remaining === 44126358);
  check("and what the allowance was to begin with", s.freeTotal === 44126358 + 1029615466);
  check("in the unit that matters: zero more hosts can start", s.hostStarts === 0 && s.exhausted === true,
    `${s.hostStarts} starts, ${(s.remaining / MB).toFixed(1)} MB left against a ${(BASE / MB).toFixed(1)} MB base`);
  check("a bucket with no charged quota says so", s.charged === 0); }

// a quota that has been bought, and partly spent
{ const s = quotaSummary({ readQuota: 10 * GB, freeQuota: 0, consumedQuota: 3 * GB, freeConsumedSize: 1 * GB }, BASE);
  check("charged and free are added, consumption subtracted", s.remaining === 7 * GB);
  check("7 GB is 97 host starts", s.hostStarts === Math.floor(7 * GB / BASE) && s.hostStarts === 97);
  check("and it is not exhausted", s.exhausted === false); }

// the edges
{ check("consumption beyond the quota does not go negative", quotaSummary({ readQuota: 1 * GB, consumedQuota: 5 * GB }, BASE).remaining === 0);
  check("exactly one base left is one start", quotaSummary({ freeQuota: BASE }, BASE).hostStarts === 1);
  check("one byte short of a base is none", quotaSummary({ freeQuota: BASE - 1 }, BASE).hostStarts === 0);
  check("missing fields read as zero rather than NaN", quotaSummary({}, BASE).remaining === 0 && quotaSummary({}, BASE).hostStarts === 0);
  check("a bucket read before its base is known does not divide by zero", quotaSummary({ freeQuota: 1 * GB }, 0).hostStarts === 0); }

// `chargedReadQuota` is what headBucket calls it; the SP calls the same thing `readQuota`
{ const s = quotaSummary({ chargedReadQuota: 2 * GB, freeQuota: 0, consumedQuota: 0 }, BASE);
  check("either name for the bought quota is understood", s.charged === 2 * GB && s.hostStarts === Math.floor(2 * GB / BASE)); }

console.log(fails ? `${fails} FAILURES` : "greenfield quota: all checks passed");
process.exit(fails ? 1 : 0);
