import { parseAbi, parseAbiItem } from 'viem';
const taskAsset = parseAbiItem('event TaskAsset(bytes32 indexed taskId, address indexed token, uint256 fee)');
const settled = parseAbiItem('event TaskSettled(bytes32 indexed taskId, bytes32 execDigest, address[] executors)');
const taskAbi = parseAbi([
  'struct Task { bytes32 mepId; uint32 stimulusSeed; uint32 steps; uint32 commitStride; bytes32 initStateRoot; uint256 fee; uint64 deadline; uint8 redundancy; }',
  'function tasks(bytes32) view returns (Task t, address client, uint64 epoch, uint64 postedAt, uint64 settledAt, bool exists, bool settled, bool disputed, bool repudiated)',
]);

export async function providerModels(ch, meps) {
  const epoch = await ch.claims.read.currentEpoch();
  const beacon = BigInt(await ch.claims.read.beacon([epoch])) !== 0n;
  return Promise.all([...meps.values()].map(async ({ info }) => {
    const votes = await ch.instances.read.eligibleVotes([info.mepId, epoch]);
    return { ...info, epoch: Number(epoch), beacon, providers: new Set(votes.map((a) => a.toLowerCase())).size, votes: votes.length };
  }));
}

// A shared rolling window, not a lifetime total. Re-scan it so reorgs cannot leave stale payouts in an accumulator.
// No caller-supplied ranges and no cache per arbitrary address: public requests cannot grow retained state.
export function hostStats(ch, market, { windowBlocks = 5000n, cacheMs = 10000 } = {}) {
  let cache = null, pending = null;
  async function scan() {
    const toBlock = await ch.pub.getBlockNumber({ cacheTime: 0 });
    const fromBlock = toBlock >= windowBlocks ? toBlock - windowBlocks + 1n : 0n;
    const earned = new Map();
    for (let from = fromBlock; from <= toBlock; from += 1000n) {
      const end = from + 999n < toBlock ? from + 999n : toBlock;
      const logs = await ch.pub.getLogs({ address: market, event: settled, fromBlock: from, toBlock: end, strict: true });
      for (const { args } of logs) {
        if (!args.executors.length) continue; // refunded, no host earned anything
        const [task,,,postedAt] = await ch.pub.readContract({ address: market, abi: taskAbi, functionName: 'tasks', args: [args.taskId], blockNumber: toBlock });
        const assetLogs=await ch.pub.getLogs({address:market,event:taskAsset,args:{taskId:args.taskId},fromBlock:postedAt,toBlock:postedAt,strict:true});
        const token=assetLogs[0]?.args.token?.toLowerCase();
        const [beneficiary, bps] = await ch.meps.read.termsOf([task.mepId], { blockNumber: toBlock });
        const cut = BigInt(beneficiary) === 0n ? 0n : task.fee * BigInt(bps) / 10000n;
        const share = (task.fee - cut) / BigInt(args.executors.length);
        for (const address of args.executors) {
          const key = address.toLowerCase(); const total = earned.get(key) || { requestsServed: 0, earnedWei: 0n, tokenEarnings:{} };
          total.requestsServed++; if(token)total.tokenEarnings[token]=(total.tokenEarnings[token]||0n)+share;else total.earnedWei += share; earned.set(key, total);
        }
      }
    }
    cache = { at: Date.now(), fromBlock: Number(fromBlock), toBlock: Number(toBlock), earned };
    return cache;
  }
  return async (instance) => {
    const snapshot = cache && Date.now() - cache.at < cacheMs ? cache : await (pending ||= scan().finally(() => { pending = null; }));
    const total = snapshot.earned.get(instance.toLowerCase()) || { requestsServed: 0, earnedWei: 0n, tokenEarnings:{} };
    return { instance: instance.toLowerCase(), fromBlock: snapshot.fromBlock, toBlock: snapshot.toBlock, requestsServed: total.requestsServed, earnedWei: String(total.earnedWei), ...(Object.keys(total.tokenEarnings).length?{tokenEarnings:Object.fromEntries(Object.entries(total.tokenEarnings).map(([k,v])=>[k,String(v)]))}:{}) };
  };
}
