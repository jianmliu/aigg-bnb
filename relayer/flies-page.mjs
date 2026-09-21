import { parseAbi } from 'viem';
import { bsc, bscTestnet } from 'viem/chains';
import { FlyCollectionAbi } from './abi.mjs';
const saleAbi = parseAbi(['function collection() view returns(address)', 'function treasury() view returns(address)', 'function available(uint256) view returns(bool)']);
const fail = (message) => { throw Object.assign(new Error(message), { statusCode: 400 }); };

// One complete, block-pinned snapshot shared across visitors; never retain per-wallet caches.
export function fliesPageReader(ch, addresses, { cacheMs = 10000 } = {}) {
  let cache, pending;
  const collection = addresses.collection, sale = addresses.inventorySale;
  async function scan(block) {
    if (!collection) throw new Error('No collection configured.');
    const read = (address, abi, functionName, args=[]) => ch.pub.readContract({address,abi,functionName,args,blockNumber:block});
    const supply = Number(await read(collection, FlyCollectionAbi, 'totalSupply'));
    if (supply > 2000) throw new Error('Collection exceeds the supported index size; an indexer upgrade is required.');
    let treasury, unavailable;
    if (sale) {
      try {
      if ((await read(sale,saleAbi,'collection')).toLowerCase() !== collection.toLowerCase()) throw new Error('Sale contract does not match this collection.');
      treasury = (await read(sale,saleAbi,'treasury')).toLowerCase();
      } catch (error) { unavailable = error.message; }
    } else unavailable = 'Treasury adoption is not configured for this deployment.';
    const multicall = ({56:bsc,97:bscTestnet})[ch.chain?.id]?.contracts.multicall3.address;
    async function batch(contracts) {
      const results=[];
      for(let start=0;start<contracts.length;start+=32) {
        const chunk=contracts.slice(start,start+32);
        if(multicall) results.push(...await ch.pub.multicall({multicallAddress:multicall,allowFailure:false,batchSize:0,blockNumber:block,contracts:chunk}));
        else for(let j=0;j<chunk.length;j+=4) results.push(...await Promise.all(chunk.slice(j,j+4).map(c=>ch.pub.readContract({...c,blockNumber:block}))));
      }
      return results;
    }
    const ids=Array.from({length:supply},(_,i)=>i+1);
    const rows=await batch(ids.flatMap(id=>['ownerOf','individuals'].map(functionName=>({address:collection,abi:FlyCollectionAbi,functionName,args:[BigInt(id)]}))));
    const tokens=ids.map((id,i)=>({id,owner:rows[i*2].toLowerCase(),sex:Number(rows[i*2+1][4]),available:false}));
    const inventory=tokens.filter(t=>t.owner===treasury);
    const available=await batch(inventory.map(t=>({address:sale,abi:saleAbi,functionName:'available',args:[BigInt(t.id)]})));
    inventory.forEach((t,i)=>{t.available=available[i];});
    return {tokens,block:Number(block),totalSupply:supply,treasury,unavailable,at:Date.now()};
  }
  return async (query) => {
    const view=query.get('view')||'adopt', sex=query.get('sex')||'all', owner=query.get('owner')?.toLowerCase();
    const page=Number(query.get('page')||1), minBlock=Number(query.get('minBlock')||0);
    if(!['adopt','mine'].includes(view)||!['all','female','male'].includes(sex)) fail('Invalid view or sex filter.');
    if(!Number.isSafeInteger(page)||page<1||!Number.isSafeInteger(minBlock)||minBlock<0) fail('Invalid page or block.');
    if(view==='mine'&&!/^0x[0-9a-f]{40}$/.test(owner||'')) fail('My flies requires an owner address.');
    while(!cache||Date.now()-cache.at>=cacheMs||cache.block<minBlock) {
      if(pending) {await pending;continue;}
      pending=(async()=>{const block=await ch.pub.getBlockNumber({cacheTime:0});cache=await scan(block);})().finally(()=>{pending=null;});
      await pending;
      if(cache.block<minBlock)fail('Requested block is not available yet.');
    }
    const matches=cache.tokens.filter(t=>(view==='mine'?t.owner===owner:t.available)&&(sex==='all'||t.sex===(sex==='female'?0:1)));
    const pages=Math.max(1,Math.ceil(matches.length/12)), current=Math.min(page,pages);
    return {collection,sale,treasury:cache.treasury,unavailable:view==='adopt'?cache.unavailable:undefined,block:cache.block,totalSupply:cache.totalSupply,view,sex,page:current,pages,pageSize:12,total:matches.length,ids:matches.slice((current-1)*12,current*12).map(t=>t.id)};
  };
}
