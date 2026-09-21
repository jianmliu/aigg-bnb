import assert from 'node:assert/strict';
import * as H from './harness.mjs';
import { capacityReader } from '../relayer/capacity.mjs';
H.forgeBuild();
const anvil=await H.startAnvil(8591);let R;
try {
 const dep=await H.deploy(anvil.rpc,{HOST_CAPACITY:'true',MULTI_ASSET_MARKET:'true'});
 const c=H.clientsFor(dep,H.KEYS[0]),host=H.clientsFor(dep,H.KEYS[1]);
 assert(dep.addresses.hostCapacity);
 assert.equal((await H.readFrom(c,dep.addresses.market,'MultiAssetTaskMarket','hostCapacity')).toLowerCase(),dep.addresses.hostCapacity.toLowerCase());
 const read=capacityReader(c.pub,dep.addresses.market,{ttl:0});
 assert.equal((await read(host.account.address)).limit,0);
 await H.sendTo(host,dep.addresses.hostCapacity,'HostCapacity','setCapacity',[10]);
 assert.equal((await read(host.account.address)).free,10);
 // Deploy another market through the production deployment path, sharing the existing global registry.
 const second=await H.deploy(anvil.rpc,{HOST_CAPACITY_REGISTRY:dep.addresses.hostCapacity});
 assert.equal(second.addresses.hostCapacity.toLowerCase(),dep.addresses.hostCapacity.toLowerCase());
 assert.equal((await capacityReader(c.pub,second.addresses.market)(host.account.address)).limit,10);
 const m=await H.registerSyntheticMep(dep,H.KEYS[0]);
 R=await H.startRelayer(dep,H.KEYS[3],[m.mepId],{env:{PORW_BEACON_LAZY:'1'}});
 assert.equal((await R.api('/deployment')).capacity.endpoint,'/capacity');
 const snapshot=await R.api('/capacity?instance='+host.account.address);
 assert.equal(snapshot.limit,10);assert.equal(snapshot.authorized,true);
 const invalid=await fetch(R.apiBase+'/capacity?instance=bad');assert.equal(invalid.status,400);
 const legacy=await H.create(c,'TaskMarket',[dep.addresses.meps,dep.addresses.instances,dep.addresses.claims,30n]);
 assert.equal((await capacityReader(c.pub,legacy)(host.account.address)).enabled,false);
 console.log('Capacity: both deployment paths, shared registry, opt-in, real API and legacy mode passed');
}finally{R?.stop();anvil.stop();}
process.exit(0);
