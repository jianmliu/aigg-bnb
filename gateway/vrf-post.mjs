import {encodeFunctionData,keccak256} from 'viem';
export const admissionExpense=c=>c.post_confirmed?String(c.admission_fee_wei||0):'0';
// A phase-6 task exists before it has executors. Recover a broadcast/save crash from
// its exact posting block, without public-RPC range logs or buying another draw.
export async function recoverPost(ch,id,task,nonce){
 const stored=await ch.market.read.tasks([id]);if(!stored[5])return null;
 const block=await ch.pub.getBlock({blockNumber:BigInt(stored[3]),includeTransactions:true});
 const input=encodeFunctionData({abi:ch.market.abi,functionName:'postTask',args:[task,nonce]}).toLowerCase();
 const tx=block.transactions.find(tx=>typeof tx==='object'&&tx.to?.toLowerCase()===ch.market.address.toLowerCase()&&tx.from?.toLowerCase()===ch.account.address.toLowerCase()&&tx.input?.toLowerCase()===input);
 if(!tx)throw Error('Cannot recover original posting transaction; refusing to repost existing task');
 return tx.hash;
}
// Durable outbox: signing can be repeated before persistence because nothing has
// been broadcast; after persistence only these exact bytes may be transmitted.
export async function persistVrfPost(ch,c,task,save){
 if(c.post_raw)return;
 const data=encodeFunctionData({abi:ch.market.abi,functionName:'postTask',args:[task,c.nonce]});
 const value=BigInt(c.task.fee)+BigInt(c.admission_fee_wei);
 const gas=await ch.market.estimateGas.postTask([task,c.nonce],{account:ch.account,value});
 if(gas>16777216n)throw Error('VRF posting exceeds transaction gas bound');
 const request=await ch.wallet.prepareTransactionRequest({account:ch.account,to:ch.market.address,data,value});
 const raw=await ch.wallet.signTransaction(request);
 c.post_raw=raw;c.post_tx=keccak256(raw);save();
}
export async function broadcastVrfPost(ch,c){
 if(!c.post_raw||keccak256(c.post_raw)!==c.post_tx)throw Error('invalid persisted posting transaction');
 try{await ch.pub.request({method:'eth_sendRawTransaction',params:[c.post_raw]});}
 catch(error){
  // Already mined/pending is normal after a crash. An unrelated RPC failure must
  // not silently count as a successful broadcast or select a fresh wallet nonce.
  try{await ch.pub.getTransaction({hash:c.post_tx});}catch{throw error;}
 }
 return c.post_tx;
}
