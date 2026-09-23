import { decodeAddress } from './abi.js';

export function matchingHost(node, snapshot) {
  return !!node?.models.size && node.identity?.instance?.toLowerCase() === snapshot?.instance?.toLowerCase() &&
    node.identity?.chainId === snapshot?.chainId && node.identity?.market?.toLowerCase() === snapshot?.market?.toLowerCase();
}

export async function saveBrowserCapacity(C, snapshot, slots) {
  const rounds=C.state.deployment?.verification?.mode==='synchronous-vrf-rounds-v1';
  const limit=rounds?Math.min(64,Number(C.state.deployment.verification.maxRoundTasks)||1):1;
  if (!Number.isInteger(slots)||slots<0||slots>limit) throw Error(rounds?'Round capacity exceeds the advertised task limit.':'This browser has one serial executor; use 0 or 1 slot.');
  const valid = () => {
    const s = C.state;
    if (!snapshot?.enabled || !s.chainOk || snapshot.instance?.toLowerCase() !== s.wallet?.toLowerCase() ||
        snapshot.chainId !== s.deployment?.chainId || snapshot.market?.toLowerCase() !== s.deployment?.addresses.market?.toLowerCase())
      throw Error('Wallet or deployment changed; refresh capacity before signing.');
    if (slots && !snapshot.authorized) throw Error('This market is not authorized for capacity reservations.');
    if (slots && !s.node?.models.size) throw Error('Start a host with a loaded model before accepting tasks.');
    if (slots && !matchingHost(s.node, snapshot)) throw Error('The running host belongs to another wallet or deployment; restart it before accepting tasks.');
  };
  valid();
  // Never trust an API-provided transaction destination without checking market wiring on chain.
  const wired = decodeAddress(await C.call(snapshot.market, 'hostCapacity()'));
  if (wired.toLowerCase() !== snapshot.registry?.toLowerCase()) throw Error('Capacity registry changed; refresh before signing.');
  valid();
  const receipt = await C.send(wired, 'setCapacity(uint16)', [slots]);
  if (receipt.status !== '0x1') throw Error('Capacity transaction reverted.');
  return receipt;
}
