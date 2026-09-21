import { parseAbi } from 'viem';
import { ReadCache } from './rpc-budget.mjs';
import { unsupportedGetter } from './enrollment.mjs';
const abi = parseAbi([
  'function hostCapacity() view returns (address)',
  'function snapshot(address) view returns (uint16 limit, uint16 active, uint16 free)',
  'function authorizedMarkets(address) view returns (bool)',
]);
const address = /^0x[0-9a-fA-F]{40}$/;
const zero = '0x' + '00'.repeat(20);

// Advisory snapshots only: markets reserve atomically. No logs, per-model walks or earnings dependency.
export function capacityReader(pub, market, options = {}) {
  const cache = new ReadCache({ ttl: 5000, max: 128, ...options });
  const wiring = new ReadCache({ ttl: 5000, ...options, max: 2 });
  async function read(instance) {
    if (!address.test(instance)) throw Object.assign(Error('instance must be an address'), { statusCode: 400 });
    instance = instance.toLowerCase();
    const registry = await wiring.get('registry', async () => {
      try { return (await pub.readContract({ address: market, abi, functionName: 'hostCapacity' })).toLowerCase(); }
      catch (e) { if (unsupportedGetter(e)) return zero; throw e; }
    });
    if (registry === zero) return { enabled: false, registry: null, market, instance };
    return cache.get(registry + ':' + instance, async () => {
      const [values, authorized] = await Promise.all([
        pub.readContract({ address: registry, abi, functionName: 'snapshot', args: [instance] }),
        wiring.get('authorized:' + registry, () => pub.readContract({ address: registry, abi, functionName: 'authorizedMarkets', args: [market] })),
      ]);
      const [limit, active, free] = values.map(Number);
      return { enabled: true, registry, market, instance, authorized, limit, active, free };
    });
  }
  read.cacheSize = () => cache.size;
  return read;
}
