// Publisher-side Greenfield operations (Node): balance, storage providers, create a public-read bucket, upload
// an object (the model payload) and verify it back from the SP. Uses the SDK's CommonJS build (the ESM build
// is bundler-only). The signing key is the deployer's (PORW_DEPLOYER_KEY) — a Greenfield account has the same
// address as the EVM account.
//   node js/greenfield_admin.mjs balance <address>
//   node js/greenfield_admin.mjs sps
//   node js/greenfield_admin.mjs upload <bucket> <object> <file> [visibility=public-read]   (needs PORW_DEPLOYER_KEY, PORW_GNFD_RPC?)
//   node js/greenfield_admin.mjs quota <bucket>                what is left, and what a base download costs against it
//   node js/greenfield_admin.mjs set-quota <bucket> <GB>       buy a monthly read quota (a transaction; the payment address pays)
//
// On quota, because it is the failure nobody sees coming. A bucket is created with `chargedReadQuota: 0` and lives
// on a one-off free allowance; every host that joins downloads the whole base, so the allowance falls by tens of
// megabytes per host and then reads simply stop -- the SP answers 406 `bucket quota overflow`, which to a browser
// tab looks like a brain that will not load. `quota` is there so that state is one command away instead of a
// forensic exercise, and it says what is left in the unit that matters: how many more hosts can start.
import { createRequire } from "node:module"; import fs from "node:fs"; import path from "node:path";
const require = createRequire(import.meta.url);
const { Client, VisibilityType, RedundancyType, Long, bytesFromBase64 } = require("@bnb-chain/greenfield-js-sdk");
const { ReedSolomon } = require("@bnb-chain/reed-solomon");
export const GNFD_RPC = process.env.PORW_GNFD_RPC || "https://gnfd-testnet-fullnode-tendermint-us.bnbchain.org"; export const GNFD_CHAIN = process.env.PORW_GNFD_CHAIN_ID || "5600";
export const client = Client.create(GNFD_RPC, GNFD_CHAIN);
export const balance = async (address) => client.account.getAccountBalance({ address, denom: "BNB" });
/** The arithmetic of a read quota, apart from the network so it can be checked: what is left to serve, and what
 *  that is worth in the unit this mesh spends it in -- one whole base download per host that joins. */
export function quotaSummary(q, baseBytes) {
  const n = (x) => Number(x || 0);
  const free = n(q.freeQuota), charged = n(q.readQuota ?? q.chargedReadQuota), used = n(q.consumedQuota);
  const remaining = Math.max(0, free + charged - used);
  return { free, charged, used, freeTotal: free + n(q.freeConsumedSize), remaining,
    hostStarts: baseBytes > 0 ? Math.floor(remaining / baseBytes) : 0, exhausted: remaining < baseBytes };
}
/** What the SP will still serve from this bucket, and what it has already served. Signed, but reads nothing on-chain. */
export async function quotaOf(bucket, pk) {
  const head = await client.bucket.headBucket(bucket); if (!head?.bucketInfo) throw new Error(`no such bucket: ${bucket}`);
  const q = (await client.bucket.getBucketReadQuota({ bucketName: bucket }, { type: "ECDSA", privateKey: pk })).body ?? {};
  const left = Number(q.freeQuota || 0) + Number(q.readQuota || 0) - Number(q.consumedQuota || 0);
  return { bucket, owner: head.bucketInfo.owner, paymentAddress: head.bucketInfo.paymentAddress,
    chargedReadQuota: Number(head.bucketInfo.chargedReadQuota || 0), ...q, remaining: left };
}
export const sps = async () => client.sp.getStorageProviders();
/** pick an in-service SP (the first by default, or PORW_GNFD_SP) */
export async function pickSp() { const all = await sps(); const want = process.env.PORW_GNFD_SP; const s = want ? all.find((x) => x.endpoint === want || x.operatorAddress === want) : all.find((x) => x.status === 0) || all[0]; if (!s) throw new Error("no storage provider"); return s; }
const [cmd, ...args] = process.argv.slice(2);
if (import.meta.url === `file://${process.argv[1]}`) {
  if (cmd === "balance") console.log(JSON.stringify(await balance(args[0])));
  else if (cmd === "sps") for (const s of await sps()) console.log(s.id, s.operatorAddress, s.endpoint, "status", s.status);
  else if (cmd === "upload") {
    const [bucket, object, file, vis = "public-read"] = args; const pk = process.env.PORW_DEPLOYER_KEY; if (!pk) throw new Error("PORW_DEPLOYER_KEY");
    const { privateKeyToAccount } = await import("viem/accounts"); const account = privateKeyToAccount(pk); const addr = account.address;
    const sp = await pickSp(); console.log("SP:", sp.operatorAddress, sp.endpoint);
    const visibility = vis === "public-read" ? VisibilityType.VISIBILITY_TYPE_PUBLIC_READ : VisibilityType.VISIBILITY_TYPE_PRIVATE;
    const sign = { type: "ECDSA", privateKey: pk };
    // bucket (idempotent: skip if it exists)
    let have = null; try { have = await client.bucket.headBucket(bucket); } catch {}
    if (!have?.bucketInfo) {
      const tx = await client.bucket.createBucket({ bucketName: bucket, creator: addr, visibility, chargedReadQuota: Long.fromString(String(Number(process.env.PORW_GNFD_READ_QUOTA || 0))), paymentAddress: addr, primarySpAddress: sp.operatorAddress });
      const sim = await tx.simulate({ denom: "BNB" }); const res = await tx.broadcast({ denom: "BNB", gasLimit: Number(sim.gasLimit), gasPrice: sim.gasPrice || "5000000000", payer: addr, granter: "", privateKey: pk });
      console.log("createBucket:", res.code === 0 ? "ok" : "FAILED", res.transactionHash || res.rawLog); if (res.code !== 0) process.exit(1);
    } else console.log("bucket exists");
    // object: create (with checksums) then upload the bytes to the SP
    const bytes = fs.readFileSync(file); const rs = new ReedSolomon(); const expectChecksums = rs.encode(Uint8Array.from(bytes)).map((h) => bytesFromBase64(h));
    let haveObj = null; try { haveObj = await client.object.headObject(bucket, object); } catch {}
    if (!haveObj?.objectInfo) {
      const tx = await client.object.createObject({ bucketName: bucket, objectName: object, creator: addr, visibility, contentType: "application/octet-stream", redundancyType: RedundancyType.REDUNDANCY_EC_TYPE, payloadSize: Long.fromInt(bytes.length), expectChecksums });
      const sim = await tx.simulate({ denom: "BNB" }); const res = await tx.broadcast({ denom: "BNB", gasLimit: Number(sim.gasLimit), gasPrice: sim.gasPrice || "5000000000", payer: addr, granter: "", privateKey: pk });
      console.log("createObject:", res.code === 0 ? "ok" : "FAILED", res.transactionHash || res.rawLog); if (res.code !== 0) process.exit(1);
      haveObj = await client.object.headObject(bucket, object);
    } else console.log("object exists (status", haveObj.objectInfo.objectStatus, ")");
    if (haveObj.objectInfo.objectStatus === 0) { // OBJECT_STATUS_CREATED: upload the payload
      const up = await client.object.uploadObject({ bucketName: bucket, objectName: object, body: { name: path.basename(file), type: "application/octet-stream", size: bytes.length, content: bytes }, txnHash: haveObj.objectInfo?.txnHash || "" }, sign);
      console.log("upload:", up.code === 0 ? "ok" : "FAILED " + JSON.stringify(up).slice(0, 300)); if (up.code !== 0) process.exit(1);
    } else console.log("object already sealed");
    console.log(`pointer: gnfd://${bucket}/${object}\nview:    ${sp.endpoint}/view/${bucket}/${object}`);
  } else if (cmd === "quota") {
    const bucket = args[0] || "aigg-brains"; const pk = process.env.PORW_DEPLOYER_KEY; if (!pk) throw new Error("PORW_DEPLOYER_KEY");
    const q = await quotaOf(bucket, pk); const MB = (n) => (n / 1024 ** 2).toFixed(1) + " MB";
    const base = Number(process.env.PORW_BASE_BYTES || 77074432); const sum = quotaSummary(q, base);
    console.log(`${q.bucket}  owner ${q.owner}  payment ${q.paymentAddress}`);
    console.log(`  charged quota   ${MB(q.chargedReadQuota)} a month${q.chargedReadQuota ? "" : "   <- none bought: this bucket is living on its free allowance"}`);
    console.log(`  free allowance  ${MB(sum.free)} left of ${MB(sum.freeTotal)}`);
    console.log(`  consumed        ${MB(q.consumedQuota)} of the charged quota this month`);
    console.log(`  REMAINING       ${MB(sum.remaining)}`);
    // the unit that matters: this mesh's hosts each pull one whole base before they can serve anything
    console.log(`\n  a host downloads ${MB(base)} before it can serve: ${sum.hostStarts} more host start(s) fit in what is left` +
      (sum.exhausted ? "  <- not even one. Every new host gets 406 bucket quota overflow, and its tab just never finishes loading." : ""));
  } else if (cmd === "set-quota") {
    const [bucket, gb] = args; const pk = process.env.PORW_DEPLOYER_KEY; if (!bucket || !gb) throw new Error("usage: set-quota <bucket> <GB>");
    if (!pk) throw new Error("PORW_DEPLOYER_KEY"); const bytes = Math.round(Number(gb) * 1024 ** 3);
    if (!(bytes > 0)) throw new Error("GB must be a positive number");
    const { privateKeyToAccount } = await import("viem/accounts"); const addr = privateKeyToAccount(pk).address;
    const head = await client.bucket.headBucket(bucket); const b = head?.bucketInfo; if (!b) throw new Error(`no such bucket: ${bucket}`);
    if (b.owner.toLowerCase() !== addr.toLowerCase()) throw new Error(`${addr} does not own ${bucket} (${b.owner} does)`);
    console.log(`${bucket}: charged read quota ${(Number(b.chargedReadQuota) / 1024 ** 3).toFixed(2)} -> ${Number(gb).toFixed(2)} GB a month, paid by ${b.paymentAddress}`);
    const tx = await client.bucket.updateBucketInfo({ bucketName: bucket, operator: addr, visibility: b.visibility,
      chargedReadQuota: { value: Long.fromString(String(bytes)) }, paymentAddress: b.paymentAddress });
    const sim = await tx.simulate({ denom: "BNB" });
    const res = await tx.broadcast({ denom: "BNB", gasLimit: Number(sim.gasLimit), gasPrice: sim.gasPrice || "5000000000", payer: addr, granter: "", privateKey: pk });
    console.log("updateBucketInfo:", res.code === 0 ? "ok " + res.transactionHash : "FAILED " + (res.rawLog || JSON.stringify(res)).slice(0, 300));
    if (res.code !== 0) process.exit(1);
    console.log("\nit is a MONTHLY charge, streamed from the payment address -- check `quota` again in a moment, and keep that account funded");
  } else console.log("usage: balance <addr> | sps | upload <bucket> <object> <file> [visibility] | quota <bucket> | set-quota <bucket> <GB>");
}
