// Publisher-side Greenfield operations (Node): balance, storage providers, create a public-read bucket, upload
// an object (the model payload) and verify it back from the SP. Uses the SDK's CommonJS build (the ESM build
// is bundler-only). The signing key is the deployer's (PORW_DEPLOYER_KEY) — a Greenfield account has the same
// address as the EVM account.
//   node js/greenfield_admin.mjs balance <address>
//   node js/greenfield_admin.mjs sps
//   node js/greenfield_admin.mjs upload <bucket> <object> <file> [visibility=public-read]   (needs PORW_DEPLOYER_KEY, PORW_GNFD_RPC?)
import { createRequire } from "node:module"; import fs from "node:fs"; import path from "node:path";
const require = createRequire(import.meta.url);
const { Client, VisibilityType, RedundancyType, Long, bytesFromBase64 } = require("@bnb-chain/greenfield-js-sdk");
const { ReedSolomon } = require("@bnb-chain/reed-solomon");
export const GNFD_RPC = process.env.PORW_GNFD_RPC || "https://gnfd-testnet-fullnode-tendermint-us.bnbchain.org"; export const GNFD_CHAIN = process.env.PORW_GNFD_CHAIN_ID || "5600";
export const client = Client.create(GNFD_RPC, GNFD_CHAIN);
export const balance = async (address) => client.account.getAccountBalance({ address, denom: "BNB" });
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
  } else console.log("usage: balance <addr> | sps | upload <bucket> <object> <file> [visibility]");
}
