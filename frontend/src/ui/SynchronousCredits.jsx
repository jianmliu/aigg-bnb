import {useEffect,useState} from 'react';
import {formatEther} from 'viem';
import * as C from '../core/controller.js';
import {Button} from './primitives.jsx';
const ZERO='0x'+'0'.repeat(40);

// Credits are on-demand reads, not a per-render RPC poll. Withdrawals always require the beneficiary's wallet.
export default function SynchronousCredits(){
 const s=C.state,[asset,setAsset]=useState(''),[balance,setBalance]=useState(null),[busy,setBusy]=useState(false),[message,setMessage]=useState('');
 const market=s.deployment?.addresses?.market,wallet=s.wallet,chain=s.deployment?.chainId;
 const token=asset.trim()||ZERO,valid=/^0x[0-9a-fA-F]{40}$/.test(token);
 const key=`${chain}:${market}:${wallet}:${token}`;
 useEffect(()=>{setBalance(null);setMessage('');},[key]);
 const current=()=>`${C.state.deployment?.chainId}:${C.state.deployment?.addresses?.market}:${C.state.wallet}:${token}`===key;
 const refresh=async()=>{const value=BigInt(await C.call(market,'credits(address,address)',[token,wallet]));if(current())setBalance({key,value});return value;};
 const run=fn=>async()=>{setBusy(true);setMessage('');try{await fn();}catch(e){setMessage(e.message||String(e));}finally{setBusy(false);}};
 const claim=async()=>{
  const amount=await refresh();if(!current())throw Error('Wallet or deployment changed. Refresh the balance.');
  if(amount===0n)throw Error('No credit to withdraw for this asset.');
  const receipt=await C.send(market,'withdrawCredit(address,address)',[token,wallet]);
  if(receipt.status!=='0x1')throw Error('Withdrawal reverted. Credit has not been marked as paid.');
  await refresh();setMessage('Withdrawal confirmed.');
 };
 const value=balance?.key===key?balance.value:null;
 return <div id="synchronous-credits">
  <h4>Withdraw task rewards and refunds</h4>
  <p className="hint">BNB by default. For a token, enter its contract address. This also includes token royalties credited directly by this market.</p>
  <label htmlFor="sync-credit-asset">Token contract (leave empty for BNB)</label>
  <input id="sync-credit-asset" value={asset} onChange={e=>setAsset(e.target.value)} placeholder="BNB or 0x…" disabled={busy}/>
  <p>{value===null?'Balance not loaded':token.toLowerCase()===ZERO?`${formatEther(value)} BNB available`:`${value} token base units available`}</p>
  <div className="row tight center">
   <Button disabled={busy||!wallet||!s.chainOk||!valid} onClick={run(refresh)}>Refresh credit</Button>
   <Button disabled={busy||!wallet||!s.chainOk||!valid||value===null||value===0n} onClick={run(claim)}>Withdraw to wallet</Button>
  </div>
  {message&&<p role="status">{message}</p>}
 </div>;
}
