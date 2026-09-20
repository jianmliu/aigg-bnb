// Personal-sign domain: no signature from another chain, deployment or relayer can wake this one.
export const wakeMessage = (dep, relayer, epoch) => [
  'aigg-bnb:wake:v1', String(dep.chainId), dep.addresses.claims.toLowerCase(),
  dep.addresses.market.toLowerCase(), relayer.toLowerCase(), String(epoch),
].join('\n');
