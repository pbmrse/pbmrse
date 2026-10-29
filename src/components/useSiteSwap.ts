'use client';
import {localizedPair} from '@/lib/ui-localization';
import {useEffect,useRef,useState} from 'react';
import {useAccount,useChainId,usePublicClient,useSignMessage,useWriteContract} from 'wagmi';
import {parseUnits,isAddress,type Hash,type Address} from 'viem';
import {MAINNET_CONTRACTS,MAINNET_SWAP_PAYMENT_RECIPIENT,ERC20_ABI} from '@/lib/contracts-mainnet-client';
import {swapQuote} from '@/lib/swap-action';
import type {BusinessSnapshot,SiteSwap} from './useBusinessAccount';
import {useLanguage} from './LanguageProvider';

type Saved={id:string;asset:'PGR'|'SOV';amount:string;recipient?:Address;hash?:Hash};
function policyRejected(error:unknown){let e=error;for(let i=0;i<8&&e&&typeof e==='object';i++){const v=e as {message?:string;shortMessage?:string;cause?:unknown};if(/can not found a matching policy/i.test(`${v.message??''} ${v.shortMessage??''}`))return true;e=v.cause;}return false;}
function rejected(error:unknown){let e=error;for(let i=0;i<8&&e&&typeof e==='object';i++){const v=e as {code?:number;name?:string;cause?:unknown};if(v.code===4001||v.name==='UserRejectedRequestError')return true;e=v.cause;}return false;}

export function useSiteSwap(snapshot:BusinessSnapshot|undefined,onUpdate:(data:BusinessSnapshot)=>void){
 const {address}=useAccount(),chainId=useChainId(),client=usePublicClient({chainId:56}),{signMessageAsync}=useSignMessage(),{writeContractAsync}=useWriteContract();
 const {language}=useLanguage(),generation=useRef(0),lock=useRef(false);
 const [busy,setBusy]=useState(false),[error,setError]=useState(''),[status,setStatus]=useState('');
 useEffect(()=>{generation.current++;lock.current=false;setBusy(false);setError('');setStatus('');return()=>{generation.current++;};},[address,chainId]);

 async function execute(asset:'PGR'|'SOV',amount:string){
  if(!address||chainId!==56||!client||lock.current)return;
  const current=generation.current,same=()=>current===generation.current,key=`pbm-swap-v1:56:${address.toLowerCase()}`;
  lock.current=true;setBusy(true);setError('');setStatus('');
  try{
   if(!/^\d{1,30}(\.\d{1,18})?$/.test(amount.trim()))throw new Error(localizedPair(language,'请输入有效数量，最多 18 位小数','Enter a valid amount with up to 18 decimals'));
   const atomic=parseUnits(amount.trim(),18);swapQuote(asset,atomic);
   const r=await fetch(`/api/user/business?walletAddress=${address}`,{cache:'no-store'});if(!r.ok)throw new Error(localizedPair(language,'请重新连接账户后继续兑换','Reconnect your account to continue'));
   const account=await r.json() as BusinessSnapshot;if(!same())return;
   if(account.walletAddress.toLowerCase()!==address.toLowerCase()||account.chainId!==56)throw new Error('Account mismatch');onUpdate(account);
   if(!account.swapEnabled)throw new Error(localizedPair(language,'站内兑换暂未开放','Site swap is paused'));
   // Old browser state must never block another order. Any actually broadcast
   // transfer is recovered by the server-side event scanner.
   localStorage.removeItem(key);
   const balance=await client.readContract({address:MAINNET_CONTRACTS[asset==='PGR'?'pgr':'sov'],abi:ERC20_ABI,functionName:'balanceOf',args:[address]});
   if(balance<atomic)throw new Error(localizedPair(language,'代币余额不足','Insufficient token balance'));
   if(await client.getBalance({address})===BigInt(0))throw new Error(localizedPair(language,'请准备 BSC 主网 BNB 支付手续费','Add BSC mainnet BNB for transaction fees'));if(!same())return;
   const saved:Saved={id:crypto.randomUUID(),asset,amount:amount.trim()};localStorage.setItem(key,JSON.stringify(saved));
   const validate=(intent:SiteSwap)=>{const q=swapQuote(asset,atomic),receiver=MAINNET_SWAP_PAYMENT_RECIPIENT;if(!isAddress(receiver)||/^0x0{40}$/i.test(receiver)||intent.wallet_address.toLowerCase()!==address.toLowerCase()||intent.intent_id!==`swap:${address.toLowerCase()}:${saved.id}`||intent.asset!==asset||BigInt(intent.amount_atomic)!==atomic||intent.recipient_address.toLowerCase()!==receiver.toLowerCase()||BigInt(intent.gross_usdt_atomic)!==q.gross||BigInt(intent.fee_usdt_atomic)!==q.fee||BigInt(intent.net_usdt_atomic)!==q.net)throw new Error('Invalid mainnet swap payment instructions');};
   const post=async(kind:'PREPARE_SWAP'|'CONFIRM_SWAP')=>{const action={kind,id:saved.id,asset,amount:saved.amount,txHash:kind==='CONFIRM_SWAP'?saved.hash:undefined};const issued=await fetch('/api/user/challenge',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({walletAddress:address,purpose:'mainnet-swap',action})});const challenge=await issued.json();if(!issued.ok)throw new Error(challenge.error);const signature=await signMessageAsync({account:address,message:String(challenge.message)});const response=await fetch('/api/user/swap',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({walletAddress:address,chainId:56,nonce:challenge.nonce,signature,action})});const result=await response.json();if(!response.ok)throw new Error(result.error);validate(result.intent);return result as {intent:SiteSwap;snapshot:BusinessSnapshot};};
   const register=async()=>{const action={kind:'CONFIRM_SWAP' as const,id:saved.id,asset,amount:saved.amount,txHash:saved.hash};const response=await fetch('/api/user/swap',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({walletAddress:address,chainId:56,sessionRegistration:true,action})});const result=await response.json();if(!response.ok)throw new Error(result.error);validate(result.intent);return result as {intent:SiteSwap;snapshot:BusinessSnapshot};};
   const prepared=await post('PREPARE_SWAP');if(!same())return;onUpdate(prepared.snapshot);saved.recipient=prepared.intent.recipient_address;localStorage.setItem(key,JSON.stringify(saved));
   setStatus(localizedPair(language,'请在您的钱包中确认','Confirm in your wallet'));
   try{saved.hash=await writeContractAsync({account:address,chainId:56,address:MAINNET_CONTRACTS[asset==='PGR'?'pgr':'sov'],abi:ERC20_ABI,functionName:'transfer',args:[saved.recipient,atomic]});}
   catch(e){localStorage.removeItem(key);if(rejected(e)||policyRejected(e))throw new Error(localizedPair(language,'付款已取消，未创建兑换记录','Payment cancelled; no exchange record was created'));throw e;}
   localStorage.setItem(key,JSON.stringify(saved));if(!same())return;
   setStatus(localizedPair(language,'等待代币确认','Waiting for token confirmation'));
   const receipt=await client.waitForTransactionReceipt({hash:saved.hash,confirmations:1,timeout:180000});if(receipt.status!=='success')throw new Error(localizedPair(language,'代币转账失败','Token transfer failed'));if(!same())return;
   // Register the mined hash through the public integration endpoint.
   // This is automatic and causes no second wallet signature or user action.
   // The independently secured service owns confirmation and settlement.
   const registered=await register();if(!same())return;onUpdate(registered.snapshot);localStorage.removeItem(key);
   setStatus(localizedPair(language,'等待代币确认','Waiting for token confirmation'));
  }catch(e){if(same())setError(e instanceof Error?e.message:'Swap unavailable');}
  finally{if(same()){lock.current=false;setBusy(false);}}
 }
 return {execute,busy,error,status,canResumePayment:false};
}
