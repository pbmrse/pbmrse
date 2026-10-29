'use client';
import {useEffect,useRef,useState} from 'react';
import {useAccount,useChainId,useSignMessage} from 'wagmi';
export type SiteSwap={intent_id:string;wallet_address:string;asset:'PGR'|'SOV';amount_atomic:string;gross_usdt_atomic:string;fee_usdt_atomic:string;net_usdt_atomic:string;recipient_address:`0x${string}`;status:'PREPARED'|'CONFIRMED';payout_mode:'LEDGER'|'WALLET';tx_hash:`0x${string}`|null;created_at:number;confirmed_at:number|null;payout_status:'READY'|'PREPARING'|'SIGNED'|'SENT'|'CONFIRMED'|'HELD'|null;payout_tx_hash:`0x${string}`|null;payout_confirmed_at:number|null;payout_last_error:string|null};
export type BusinessSnapshot={
 swapEnabled:boolean;swaps:SiteSwap[];pendingSwap:SiteSwap|null;
  stake:{principal:string;pendingPgr:string};
  mining:{investmentPgr:string;pendingSov:string;earnedSov:string;capped:boolean;cycle:number};
  walletAddress:string;chainId:number;availableUsdt:string;depositAddress:`0x${string}`;referrerWallet:string|null;claimsEnabled:boolean;reservedPgr:string;reservedSov:string;
  operations:{operation_id:string;operation_type:string;amount_atomic:string;asset:string;status:string;created_at:number;tx_hash:string|null}[];
  claimHistory:{claim_id:string;asset:'PGR'|'SOV';amount_atomic:string;status:'RESERVED'|'MINTED';created_at:number;tx_hash:string|null;confirmed_at:number|null}[];
  pendingMiningPurchase:{intent_id:string;amount_atomic:string;recipient_address:`0x${string}`;created_at:number;tx_hash:`0x${string}`|null}|null;
  miningEnabled:boolean;miningPolicyStatus:string;miningRewards:{reward_id:string;source_wallet:string;kind:string;generation:number;rate_bps:number;amount_atomic:string;created_at:number}[];
  actionsEnabled:boolean;unavailableReason:string;
};
export function useBusinessAccount({autoAuthorize=false}:{autoAuthorize?:boolean}={}){
 const {address}=useAccount(),chainId=useChainId(),{signMessageAsync}=useSignMessage();
 const [snapshot,setSnapshot]=useState<BusinessSnapshot>(),[busy,setBusy]=useState(false),[error,setError]=useState(''),[needsAuthorization,setNeedsAuthorization]=useState(false);
 const generation=useRef(0),sequence=useRef(0),lock=useRef(false);
 const matches=(data:BusinessSnapshot)=>data.walletAddress?.toLowerCase()===address?.toLowerCase()&&data.chainId===chainId;
 async function load(allowSignature=true){
  if(!address||chainId!==56||lock.current)return;
  const current=generation.current,seq=++sequence.current,same=()=>current===generation.current&&seq===sequence.current;
  lock.current=true;setBusy(true);setError('');
  try{
   const existing=await fetch(`/api/user/business?walletAddress=${address}`,{cache:'no-store'});if(!same())return;
   if(existing.ok){const data=await existing.json();if(!same())return;if(!matches(data))throw new Error('Account identity changed');setSnapshot(data);setNeedsAuthorization(false);return;}
   if(existing.status!==401){const data=await existing.json();throw new Error(data.error||'Unable to load account');}
   setNeedsAuthorization(true);setSnapshot(undefined);if(!allowSignature)return;
   const issued=await fetch('/api/user/challenge',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({walletAddress:address,purpose:'business'})});
   const challenge=await issued.json();if(!same())return;if(!issued.ok)throw new Error(challenge.error);
   const signature=await signMessageAsync({account:address,message:challenge.message});if(!same())return;
   const response=await fetch('/api/user/business',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({walletAddress:address,chainId,nonce:challenge.nonce,signature})});
   const data=await response.json();if(!same())return;if(!response.ok)throw new Error(data.error);
   if(matches(data)){setSnapshot(data);setNeedsAuthorization(false);}else throw new Error('Account identity changed');
  }catch(e){if(same())setError(e instanceof Error?e.message:'Unable to load business account');}
  finally{if(same()){lock.current=false;setBusy(false);}}
 }
 useEffect(()=>{generation.current++;sequence.current++;lock.current=false;setSnapshot(undefined);setBusy(false);setError('');setNeedsAuthorization(false);void load(autoAuthorize);return()=>{generation.current++;sequence.current++;};},[address,chainId,autoAuthorize]);
 async function refresh(){
  if(!address||chainId!==56||lock.current)return;
  const current=generation.current,seq=++sequence.current;
  const response=await fetch(`/api/user/business?walletAddress=${address}`,{cache:'no-store'});
  if(current!==generation.current||seq!==sequence.current)return;
  if(response.status===401){setSnapshot(undefined);setNeedsAuthorization(true);return;}if(!response.ok)return;
  const data=await response.json();if(current===generation.current&&seq===sequence.current&&matches(data)){setSnapshot(data);setNeedsAuthorization(false);}
 }
 function accept(data:BusinessSnapshot){if(matches(data)){sequence.current++;lock.current=false;setBusy(false);setSnapshot(data);setNeedsAuthorization(false);}}
 useEffect(()=>{if(!snapshot||chainId!==56)return;let lastRefresh=Date.now();const refreshVisible=()=>{if(document.visibilityState!=='visible'||Date.now()-lastRefresh<60000)return;lastRefresh=Date.now();void refresh().catch(()=>{});};const timer=setInterval(refreshVisible,15000);const onFocus=()=>refreshVisible();document.addEventListener('visibilitychange',onFocus);window.addEventListener('focus',onFocus);return()=>{clearInterval(timer);document.removeEventListener('visibilitychange',onFocus);window.removeEventListener('focus',onFocus);};},[address,chainId,!!snapshot]);
 return {snapshot,busy,error,needsAuthorization,load:()=>load(true),refresh,accept,invalidate:()=>{setSnapshot(undefined);void load(false);},canLoad:!!address&&chainId===56};
}
