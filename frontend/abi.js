// Minimal ABI helpers for the frontend (no library): selectors + static/simple dynamic args, and decoding of
// single static return values. Enough for the registry / claim manager / market calls the page makes.
import { keccak_256 } from "@noble/hashes/sha3.js";
const utf8 = (s) => new TextEncoder().encode(s);
export const hex = (b) => "0x" + Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
export const unhex = (s) => Uint8Array.from((s.startsWith("0x") ? s.slice(2) : s).match(/../g) || [], (h) => parseInt(h, 16));
const word = (v) => { if (typeof v === "bigint" || typeof v === "number") { let x = BigInt(v); const o = new Uint8Array(32); for (let i = 31; i >= 0; i--) { o[i] = Number(x & 255n); x >>= 8n; } return o; } const b = unhex(v); const o = new Uint8Array(32); o.set(b, 32 - b.length); return o; };
export const selector = (sig) => keccak_256(utf8(sig)).slice(0, 4);
/** encode(sig, args): args are numbers/bigints, 0x-hex (address/bytes32, right-aligned), arrays of bytes32, or {bytes: 0x..} */
export function encode(sig, args = []) {
  const head = [], tail = []; const types = sig.slice(sig.indexOf("(") + 1, -1).split(",").filter(Boolean);
  let dynOffset = 32 * types.length; const parts = [];
  types.forEach((t, i) => { const a = args[i];
    if (t.endsWith("[]")) { const items = a.map(word); parts.push({ dyn: true, data: [word(items.length), ...items] }); }
    else if (t === "bytes" || t === "string") { const b = t === "string" ? utf8(a) : unhex(a); const padded = new Uint8Array(Math.ceil(b.length / 32) * 32); padded.set(b); parts.push({ dyn: true, data: [word(b.length), padded] }); }
    else parts.push({ dyn: false, data: [word(a)] }); });
  const out = [selector(sig)];
  for (const p of parts) { if (p.dyn) { out.push(word(dynOffset)); dynOffset += p.data.reduce((s, x) => s + x.length, 0); } else out.push(p.data[0]); }
  for (const p of parts) if (p.dyn) out.push(...p.data);
  return hex(out.reduce((acc, x) => { const o = new Uint8Array(acc.length + x.length); o.set(acc); o.set(x, acc.length); return o; }, new Uint8Array(0)));
}
export const decodeUint = (data) => BigInt(data.slice(0, 66));
export const decodeBool = (data) => BigInt(data.slice(0, 66)) !== 0n;
export const decodeAddress = (data) => "0x" + data.slice(26, 66).toLowerCase();
export const decodeBytes32 = (data) => data.slice(0, 66);
