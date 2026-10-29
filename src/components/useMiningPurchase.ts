'use client';
import { localizedPair } from '@/lib/ui-localization';
import {useEffect,useRef,useState} from 'react';
import {useAccount,useChainId,usePublicClient,useSignMessage,useWriteContract} from 'wagmi';
import {parseUnits,formatUnits,isHash,type Hash,type Address} from 'viem';
import {MAINNET_CONTRACTS,MAINNET_MINING_PAYMENT_RECIPIENT,ERC20_ABI} from '@/lib/contracts-mainnet-client';
import type {MiningAction} from '@/lib/mining-action';
import type {BusinessSnapshot} from './useBusinessAccount';
import {useLanguage} from './LanguageProvider';
import {getLockedReferrer} from '@/lib/ledger';
type Saved={id:string;amount:string;referrerWallet:string|null;recipient?:Address;hash?:Hash;paymentState?:'UNPAID'|'AWAITING_WALLET'|'SENT'};
function walletRejected(error:unknown){let e=error;for(let i=0;i<8&&e&&typeof e==='object';i++){const item=e as {code?:number;name?:string;cause?:unknown};if(item.code===4001||item.name==='UserRejectedRequestError')return true;e=item.cause;}return false;}
export function useMiningPurchase(snapshot:BusinessSnapshot|undefined,onUpdate:(data:BusinessSnapshot)=>void){
 const {address}=useAccount(),chainId=useChainId(),client=usePublicClient({chainId:56}),{signMessageAsync}=useSignMessage(),{writeContractAsync}=useWriteContract();
 const {language}=useLanguage();const zh=language.startsWith('zh');
 const generation=useRef(0),lock=useRef(false);const [canResumePayment,setCanResumePayment]=useState(false);const [busy,setBusy]=useState(false),[error,setError]=useState(''),[status,setStatus]=useState('');
 useEffect(()=>{generation.current++;lock.current=false;setBusy(false);setError('');setStatus('');return()=>{generation.current++;};},[address,chainId]);
 useEffect(()=>{const pending=snapshot?.pendingMiningPurchase;let resumable=false;if(address&&chainId===56&&pending&&!pending.tx_hash){try{const saved=JSON.parse(localStorage.getItem(`pbm-mining-v2:56:${address.toLowerCase()}`)||'null') as Saved|null;resumable=saved?.id===pending.intent_id.split(':').at(-1)&&saved?.paymentState==='UNPAID'&&!saved?.hash;}catch{}}setCanResumePayment(resumable);},[address,chainId,snapshot]);
 async function buy(amount:string,referrerWallet?:string|null,recoveryHash?:string){
  if(!address||chainId!==56||!client||lock.current)return;
  const current=generation.current,same=()=>current===generation.current,key=`pbm-mining-v2:56:${address.toLowerCase()}`;
  lock.current=true;setBusy(true);setError('');
  try{
   const atomic=parseUnits(amount,18);if(atomic<BigInt(1000)*BigInt('1000000000000000000'))throw new Error(localizedPair(language, '矿储单次购买价值至少为 500 USDT（至少 1000 PGR）', 'Minimum mining purchase: 1000 PGR (500 USDT)'));
   let saved=JSON.parse(localStorage.getItem(key)||'null') as Saved|null;
   // Refresh the signed read session before deciding whether a new payment is safe.
   const accountResponse=await fetch(`/api/user/business?walletAddress=${address}`,{cache:'no-store'});
   if(!accountResponse.ok)throw new Error(localizedPair(language, '账户连接已过期，请重新连接账户。', 'Reconnect your mining account.'));
   const account=await accountResponse.json() as BusinessSnapshot;if(!same())return;onUpdate(account);
   const pending=account.pendingMiningPurchase;
   if(pending){
    const id=pending.intent_id.split(':').at(-1)!;
    const localMatches=saved?.id===id;
    const hash=pending.tx_hash??(localMatches?saved?.hash:undefined)??(recoveryHash?.trim()||undefined);
    const unpaid=localMatches&&saved?.paymentState==='UNPAID'&&!saved.hash;
    if(!hash&&!unpaid)throw new Error(localizedPair(language, '找到未完成购买，请填写钱包中的原 PGR 交易哈希恢复；不会重复付款。', 'Pending purchase found. Enter the original PGR transaction hash to recover without another payment.'));
    saved={id,amount:formatUnits(BigInt(pending.amount_atomic),18),referrerWallet:account.referrerWallet,recipient:pending.recipient_address,hash:hash as Hash|undefined,paymentState:hash?'SENT':'UNPAID'};
    localStorage.setItem(key,JSON.stringify(saved));
   }
   if(!pending&&saved?.paymentState==='UNPAID'&&!saved.recipient&&!saved.hash){localStorage.removeItem(key);saved=null;}
   if(saved?.hash&&!isHash(saved.hash))throw new Error(localizedPair(language, '交易哈希格式不正确。', 'Invalid transaction hash.'));
   if(!saved?.hash&&!account.miningEnabled)throw new Error(localizedPair(language, '矿储完整奖励规则尚未配置，购买暂未开放。', 'The complete mining reward policy is not configured yet.'));
   if(saved&&parseUnits(saved.amount,18)!==atomic)throw new Error(localizedPair(language, '请先以原金额完成未结束的矿储购买。', 'Finish the pending purchase with its original amount.'));
   if(!saved?.hash){
    if(saved&&saved.paymentState!=='UNPAID')throw new Error(localizedPair(language, '付款状态尚未明确，请使用原交易哈希恢复。', 'Payment status is unknown. Recover with the original transaction hash.'));
    const balance=await client.readContract({address:MAINNET_CONTRACTS.pgr,abi:ERC20_ABI,functionName:'balanceOf',args:[address]});
    if(balance<atomic)throw new Error(localizedPair(language, 'PGR 余额不足。', 'Insufficient PGR balance.'));
    if(await client.getBalance({address})===BigInt(0))throw new Error(localizedPair(language, '请先准备 BSC 主网 BNB 支付手续费。', 'Add BSC mainnet BNB for transaction fees.'));
    if(!same())return;
   }
   if(!saved){saved={id:crypto.randomUUID(),amount,referrerWallet:account.referrerWallet??getLockedReferrer()??referrerWallet??null,paymentState:'UNPAID'};localStorage.setItem(key,JSON.stringify(saved));}
   const post=async(path:string,body:unknown)=>{const r=await fetch(path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});const d=await r.json();if(!r.ok)throw new Error(d.error);return d;};
   const authorize=async(action:MiningAction)=>{const challenge=await post('/api/user/challenge',{walletAddress:address,purpose:'mining-action',action});if(!same())throw new Error('Wallet changed');const signature=await signMessageAsync({account:address,message:challenge.message});if(!same())throw new Error('Wallet changed');return post('/api/user/mining',{walletAddress:address,chainId:56,nonce:challenge.nonce,signature,action});};
   if(!saved.recipient||!saved.hash){
    const result=await authorize({kind:'PREPARE_MINING',id:saved.id,amount:saved.amount,referrerWallet:saved.referrerWallet});if(!same())return;
    if(result.intent.status==='CONFIRMED'){localStorage.removeItem(key);onUpdate(result.snapshot);setStatus(localizedPair(language, '矿储已入账', 'Mining investment confirmed'));return;}
    if(result.intent.recipient_address.toLowerCase()!==MAINNET_MINING_PAYMENT_RECIPIENT.toLowerCase())throw new Error('Invalid PGR consumption recipient');
    saved.recipient=result.intent.recipient_address;localStorage.setItem(key,JSON.stringify(saved));onUpdate(result.snapshot);
   }
   if(saved.recipient?.toLowerCase()!==MAINNET_MINING_PAYMENT_RECIPIENT.toLowerCase())throw new Error('Invalid PGR consumption recipient');
   if(!same())return;
   if(!saved.hash){setStatus(localizedPair(language, '请在钱包确认消耗 PGR 购买矿储', 'Confirm the PGR consumption payment in your wallet'));saved.paymentState='AWAITING_WALLET';localStorage.setItem(key,JSON.stringify(saved));setCanResumePayment(false);try{saved.hash=await writeContractAsync({account:address,chainId:56,address:MAINNET_CONTRACTS.pgr,abi:ERC20_ABI,functionName:'transfer',args:[saved.recipient!,atomic]});}catch(e){if(walletRejected(e)){saved.paymentState='UNPAID';localStorage.setItem(key,JSON.stringify(saved));if(same())setCanResumePayment(true);}throw e;}saved.paymentState='SENT';localStorage.setItem(key,JSON.stringify(saved));}
   if(!same())return;setStatus(localizedPair(language, '正在保存原 PGR 交易记录', 'Saving the original PGR payment'));
   const initial=await client.waitForTransactionReceipt({hash:saved.hash,confirmations:1,timeout:180000});
   if(initial.status!=='success')throw new Error(localizedPair(language, 'PGR 交易失败，请检查钱包中的原交易。', 'PGR payment reverted. Check the original transaction in your wallet.'));
   if(!same())return;
   const tracked=await authorize({kind:'CONFIRM_MINING',id:saved.id,amount:saved.amount,referrerWallet:saved.referrerWallet,txHash:saved.hash});
   if(!same())return;onUpdate(tracked.snapshot);
   if(tracked.intent.status==='CONFIRMED'){localStorage.removeItem(key);setStatus(localizedPair(language, '矿储已入账', 'Mining investment confirmed'));return;}
   setStatus(localizedPair(language, '等待 PGR 交易 12 次确认', 'Waiting for 12 PGR confirmations'));
   const receipt=await client.waitForTransactionReceipt({hash:saved.hash,confirmations:12,timeout:180000});if(receipt.status!=='success')throw new Error(localizedPair(language, 'PGR 交易失败，请检查原交易。', 'PGR payment reverted; check the original transaction.'));
   if(!same())return;const result=await authorize({kind:'CONFIRM_MINING',id:saved.id,amount:saved.amount,referrerWallet:saved.referrerWallet,txHash:saved.hash});if(!same())return;
   if(result.intent.status!=='CONFIRMED')throw new Error(localizedPair(language, '交易确认仍在进行，请恢复原购买。', 'Payment confirmation is still pending; resume the same purchase.'));
   localStorage.removeItem(key);onUpdate(result.snapshot);setStatus(localizedPair(language, '矿储已入账', 'Mining investment confirmed'));
  }catch(e){if(same())setError(e instanceof Error?e.message:'Mining purchase unavailable');}finally{if(same()){lock.current=false;setBusy(false);}}
 }
 return {buy,busy,error,status,canResumePayment};
}
