// viem clients + a deployment descriptor { chainId, rpc, addresses: {...} } (deployments/<chainId>.json from DeployBNB).
import { createPublicClient, createWalletClient, http, defineChain, getContract } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { InstanceRegistryAbi, ClaimManagerAbi, TaskMarketAbi, MEPRegistryAbi, BeaconAbi, RelayRegistryAbi, FlyCollectionAbi, CollectionWhitelistAbi } from "./abi.mjs";

import {SynchronousMarketAbi,SynchronousDisputeAbi} from "./synchronous.mjs";

export function chainOf(chainId, rpc) {
  return defineChain({ id: chainId, name: `chain-${chainId}`, nativeCurrency: { name: "BNB", symbol: "BNB", decimals: 18 }, rpcUrls: { default: { http: [rpc] } } });
}
export function clients(dep, privateKey = null) {
  const chain = chainOf(dep.chainId, dep.rpc);
  const pub = createPublicClient({ chain, transport: http(dep.rpc) });
  const account = privateKey ? privateKeyToAccount(privateKey) : null;
  const wallet = account ? createWalletClient({ chain, transport: http(dep.rpc), account }) : null;
  const c = (address, abi) => getContract({ address, abi, client: { public: pub, wallet } });
  const a = dep.addresses;
  return { chain, pub, wallet, account, instances: c(a.instances, InstanceRegistryAbi), claims: c(a.claims, ClaimManagerAbi), market: c(a.market, [...TaskMarketAbi,...SynchronousMarketAbi]), disputes: a.disputes ? c(a.disputes,SynchronousDisputeAbi) : null, meps: c(a.meps, MEPRegistryAbi), beacon: a.beacon ? c(a.beacon, BeaconAbi) : null, relays: c(a.relays, RelayRegistryAbi), collection: a.collection ? c(a.collection, FlyCollectionAbi) : null, whitelist: a.whitelist ? c(a.whitelist, CollectionWhitelistAbi) : null };
}
export const eip712Domains = (dep) => ({
  claimManager: { name: "PoRW Mesh", version: "1", chainId: dep.chainId, verifyingContract: dep.addresses.claims },
  market: { name: "PoRW Mesh", version: "1", chainId: dep.chainId, verifyingContract: dep.addresses.market },
  registry: { name: "PoRW Mesh", version: "1", chainId: dep.chainId, verifyingContract: dep.addresses.instances },
});
