'use client';
import { localizedPair } from '@/lib/ui-localization';
import {useEffect,useRef,useState} from 'react';
import {useAccount,useChainId,usePublicClient,useSignMessage,useWriteContract} from 'wagmi';
import {isAddress,isHash,parseUnits,type Hash} from 'viem';
import {MAINNET_CONTRACTS,ERC20_ABI} from '@/lib/contracts-mainnet-client';
import {normalizeBankAction,type BankAction} from '@/lib/bank-action';
import {useLanguage} from './LanguageProvider';
import type {BusinessSnapshot} from './useBusinessAccount';
type Saved={action:BankAction;depositHash?:Hash;paymentState?:'UNPAID'|'AWAITING_WALLET'|'SENT'};
function policyRejected(error:unknown){let e=error;for(let i=0;i<8&&e&&typeof e==='object';i++){const v=e as {message?:string;shortMessage?:string;cause?:unknown};if(/can not found a matching policy/i.test(`${v.message??''} ${v.shortMessage??''}`))return true;e=v.cause;}return false;}
function walletRejected(error:unknown){let e=error;for(let i=0;i<8&&e&&typeof e==='object';i++){const item=e as {code?:number;name?:string;cause?:unknown};if(item.code===4001||item.name==='UserRejectedRequestError')return true;e=item.cause;}return false;}
export function useBankOperation(snapshot:BusinessSnapshot|undefined,onUpdate:(data:BusinessSnapshot)=>void){
 const {language}=useLanguage();const zh=language.startsWith('zh');
 const {address}=useAccount();const chainId=useChainId();const client=usePublicClient({chainId:97});const {signMessageAsync}=useSignMessage();const {writeContractAsync}=useWriteContract();
 const [busy,setBusy]=useState(false),[error,setError]=useState(''),[status,setStatus]=useState(''),[txHash,setTxHash]=useState<Hash>(),[needsRecovery,setNeedsRecovery]=useState(false);const generation=useRef(0),lock=useRef(false);
 useEffect(()=>{generation.current++;lock.current=false;setBusy(false);setError('');setStatus('');setTxHash(undefined);setNeedsRecovery(false);return()=>{generation.current++;};},[address,chainId]);
 useEffect(()=>{if(!address||chainId!==97||!snapshot)return;const key=`pbm-bank-v2:97:${address.toLowerCase()}`;try{const saved=JSON.parse(localStorage.getItem(key)||'null') as Saved|null;if(saved){const accepted=snapshot.operations.find(x=>x.operation_id===`bank:${address.toLowerCase()}:${saved.action.id}`);if(accepted?.status==='CONFIRMED'){localStorage.removeItem(key);setStatus(accepted.status);setNeedsRecovery(false);}else setNeedsRecovery(saved.action.kind==='STAKE'&&(!!saved.depositHash||saved.paymentState!=='UNPAID'));}}catch{/* Corrupt browser data cannot authorize a payment. */}},[snapshot,address,chainId]);
 async function execute(kind:BankAction['kind'],amount:string,referrerWallet?:string|null,recoveryHash?:string){
  if(!address||chainId!==97||!client||!snapshot?.actionsEnabled||lock.current)return;
  const current=generation.current,same=()=>current===generation.current;lock.current=true;setBusy(true);setError('');setStatus('');
  const key=`pbm-bank-v2:97:${address.toLowerCase()}${kind==='STAKE'?'':`:${kind}`}`;
  const post=async(path:string,body:unknown)=>{const response=await fetch(path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});const data=await response.json();if(!response.ok)throw new Error(data.error||'Operation failed');return data;};
  try{
   let saved=JSON.parse(localStorage.getItem(key)||'null') as Saved|null;
   const response=await fetch(`/api/user/business?walletAddress=${address}`,{cache:'no-store'});
   if(!response.ok)throw new Error(localizedPair(language, '账户连接已过期，请重新连接账户。', 'Reconnect your account.'));
   const account=await response.json() as BusinessSnapshot;if(!same())return;
   if(account.walletAddress?.toLowerCase()!==address.toLowerCase()||account.chainId!==97)throw new Error('Account identity changed');
   onUpdate(account);
   if(saved){
    const operationId=`bank:${address.toLowerCase()}:${saved.action.id}`;
    const accepted=account.operations.find(x=>x.operation_id===operationId);
    if(accepted){
     // Replay the same intent after a lost response. The server applies
     // operations idempotently by their existing operation identifier.
     localStorage.removeItem(key);saved=null;setNeedsRecovery(false);setStatus(accepted.status);if(accepted.status!=='CONFIRMED')return;
    }else{
     // A snapshot only includes the latest 100 operations. Check the exact
     // server record before reusing a locally saved payment intent.
     const check=await fetch(`/api/user/bank/status?operationId=${encodeURIComponent(operationId)}`,{cache:'no-store'});
     if(!same())return;
     if(check.ok){
      const verified=await check.json() as {operation?:{status?:string}};
      if(!same())return;
      if(verified.operation?.status==='CONFIRMED'){
       localStorage.removeItem(key);saved=null;setNeedsRecovery(false);
      }
     }else if(check.status===404){
      // An intent that never reached the wallet cannot have transferred funds.
      // Release only this demonstrably unpaid local draft; ambiguous payments
      // and submitted operations must keep their original recovery identity.
      if(saved.paymentState==='UNPAID'&&!saved.depositHash){
       localStorage.removeItem(key);saved=null;setNeedsRecovery(false);
      }
     }else{
      throw new Error(localizedPair(language, '无法核实上一笔操作状态，请稍后重试。', 'Unable to verify the previous operation; retry later.'));
     }
    }
   }
   if(!account.actionsEnabled)throw new Error('USDT banking is not open');
   let candidate:BankAction={kind,id:saved?.action.id??crypto.randomUUID(),amount,referrerWallet:saved?saved.action.referrerWallet:(account.referrerWallet??null)};
   let normalized=normalizeBankAction(candidate),amountAtomic=BigInt(normalized.amountAtomic);
   if(saved&&normalizeBankAction(saved.action).purpose!==normalized.purpose&&saved.action.kind==='STAKE'&&!saved.depositHash&&saved.paymentState==='UNPAID'){
    // No wallet transfer was submitted. The original unpaid draft may be replaced.
    localStorage.removeItem(key);saved=null;setNeedsRecovery(false);
    candidate={kind,id:crypto.randomUUID(),amount,referrerWallet:account.referrerWallet??referrerWallet??null};
    normalized=normalizeBankAction(candidate);amountAtomic=BigInt(normalized.amountAtomic);
   }
   if(saved&&normalizeBankAction(saved.action).purpose!==normalized.purpose){
    // A known transaction hash can be resumed without initiating another transfer.
    // Do not replace the original intent or send funds for a different amount.
    if(saved.action.kind==='STAKE'&&saved.depositHash){
     setStatus(localizedPair(language, '正在核实上一笔已发送的质押，请完成后重试新金额。', 'Verifying the previously sent stake; retry the new amount after it completes.'));
     const previousReceipt=await client.getTransactionReceipt({hash:saved.depositHash});
     const latestBlock=await client.getBlockNumber();
     if(latestBlock<previousReceipt.blockNumber+BigInt(11)){
      throw new Error(localizedPair(language, '上一笔转账仍在等待 12 次链上确认。请稍后重试，系统不会再次扣款。', 'The previous transfer needs 12 confirmations. Retry later; no second payment will be sent.'));
     }
     if(previousReceipt.status!=='success'){
      // Only an explicitly reverted on-chain transfer is safe to discard.
      localStorage.removeItem(key);setNeedsRecovery(false);
      setStatus(localizedPair(language, '上一笔链上转账已确认失败，旧操作已解除。请再次点击质押新金额。', 'The previous on-chain transfer reverted. Click Stake again to start the new amount.'));
      return;
     }
     const confirmed=await post('/api/user/deposit/confirm',{walletAddress:address,chainId:97,txHash:saved.depositHash});
     if(confirmed.status!=='CONFIRMED')throw new Error('Original deposit is still pending');
     saved.action={...saved.action,depositHash:saved.depositHash};localStorage.setItem(key,JSON.stringify(saved));
     // The original action must be signed and applied with its original amount.
     const challenge=await post('/api/user/challenge',{walletAddress:address,purpose:'bank-action',action:saved.action});
     const signature=await signMessageAsync({account:address,message:challenge.message});
     const result=await post('/api/user/bank',{walletAddress:address,chainId:97,nonce:challenge.nonce,signature,action:saved.action});
     localStorage.removeItem(key);setNeedsRecovery(false);onUpdate(result.snapshot);
     setStatus(localizedPair(language, '上一笔质押已恢复，请再次点击质押新金额。', 'Previous stake recovered. Click Stake again for the new amount.'));
     return;
    }
    throw new Error(localizedPair(language, '上一笔质押尚未核实，请先恢复原交易，避免重复付款。', 'Previous stake is not verified. Recover its original transaction before starting a new payment.'));
   }
   if(normalized.referrerWallet===address.toLowerCase())throw new Error('Self-referral is not allowed');
   if(kind==='WITHDRAW_USDT'&&amountAtomic<BigInt(50)*BigInt('1000000000000000000'))throw new Error('Minimum USDT withdrawal is 50');
   if(kind==='CANCEL_STAKE'&&amountAtomic>parseUnits(account.stake.principal,18))throw new Error('Invalid cancellation amount');
   if(kind==='WITHDRAW_USDT'&&amountAtomic>parseUnits(account.availableUsdt,18))throw new Error('Insufficient account USDT');
   if(!saved)saved={action:candidate,paymentState:'UNPAID'};
   if(kind==='STAKE'){
    if(!isAddress(account.depositAddress))throw new Error('Invalid deposit address');
    if(recoveryHash?.trim()){
     const hash=recoveryHash.trim();if(!isHash(hash))throw new Error('Invalid transaction hash');
     if(saved.depositHash&&saved.depositHash.toLowerCase()!==hash.toLowerCase())throw new Error('Original deposit transaction changed');
     saved.depositHash=hash as Hash;saved.paymentState='SENT';localStorage.setItem(key,JSON.stringify(saved));setNeedsRecovery(false);
    }
    if(saved.depositHash&&!isHash(saved.depositHash))throw new Error('Invalid transaction hash');
    if(!saved.depositHash&&saved.paymentState!=='UNPAID'){
     setNeedsRecovery(true);throw new Error(localizedPair(language, '付款状态尚未明确，请填写钱包中的原 USDT 交易哈希恢复；不会重复付款。', 'Payment status is unknown. Enter the original USDT transaction hash to recover without another payment.'));
    }
    // New stakes always transfer the full requested amount from the wallet. Historical ledger credits remain untouched.
    const deficit=amountAtomic;
    if(!saved.depositHash&&deficit>BigInt(0)){
     const balance=await client.readContract({address:MAINNET_CONTRACTS.usdt,abi:ERC20_ABI,functionName:'balanceOf',args:[address]});
     if(balance<deficit)throw new Error(localizedPair(language, 'USDT 余额不足。', 'Insufficient USDT balance.'));
     if(await client.getBalance({address})===BigInt(0))throw new Error(localizedPair(language, '请先准备测试网 BNB 支付手续费。', 'Add testnet BNB for transaction fees.'));
     if(!same())return;
     setStatus(localizedPair(language, '请在钱包确认 USDT 充值', 'Confirm USDT deposit in your wallet'));
     saved.paymentState='AWAITING_WALLET';localStorage.setItem(key,JSON.stringify(saved));
     try{saved.depositHash=await writeContractAsync({account:address,chainId:97,address:MAINNET_CONTRACTS.usdt,abi:ERC20_ABI,functionName:'transfer',args:[account.depositAddress,deficit]});}
     catch(e){if(walletRejected(e)||policyRejected(e)){saved.paymentState='UNPAID';localStorage.setItem(key,JSON.stringify(saved));}else if(same())setNeedsRecovery(true);throw e;}
     saved.paymentState='SENT';localStorage.setItem(key,JSON.stringify(saved));if(!same())return;
    }
    if(saved.depositHash){
     setTxHash(saved.depositHash);setStatus(localizedPair(language, '等待充值交易 12 次确认', 'Waiting for 12 deposit confirmations'));
     const receipt=await client.waitForTransactionReceipt({hash:saved.depositHash,confirmations:12,timeout:180000});
     if(receipt.status!=='success'){delete saved.depositHash;saved.paymentState='UNPAID';localStorage.setItem(key,JSON.stringify(saved));throw new Error('USDT deposit reverted; retry');}
     if(!same())return;
     const confirmed=await post('/api/user/deposit/confirm',{walletAddress:address,chainId:97,txHash:saved.depositHash});
     if(confirmed.status!=='CONFIRMED')throw new Error('Deposit confirmation pending; retry the original transaction');
     saved.action={...saved.action,depositHash:saved.depositHash};localStorage.setItem(key,JSON.stringify(saved));
    }
   }
   if(!same())return;localStorage.setItem(key,JSON.stringify(saved));setStatus(localizedPair(language, '请签名确认操作', 'Sign the operation'));
   const challenge=await post('/api/user/challenge',{walletAddress:address,purpose:'bank-action',action:saved.action});
   if(!same())return;const signature=await signMessageAsync({account:address,message:challenge.message});if(!same())return;
   const result=await post('/api/user/bank',{walletAddress:address,chainId:97,nonce:challenge.nonce,signature,action:saved.action});
   if(!same())return;localStorage.removeItem(key);setNeedsRecovery(false);onUpdate(result.snapshot);setStatus(result.operation.status);
  }catch(e){if(same())setError(e instanceof Error?e.message:'Unable to complete operation');}
  finally{if(same()){lock.current=false;setBusy(false);}}
 }
 async function releaseUnbroadcastStake(){
  if(!address||chainId!==97||!client||lock.current)return;
  lock.current=true;setBusy(true);setError('');
  const key=`pbm-bank-v2:97:${address.toLowerCase()}`;
  try{
   const saved=JSON.parse(localStorage.getItem(key)||'null') as Saved|null;
   if(!saved||saved.action.kind!=='STAKE'||!saved.depositHash||!isHash(saved.depositHash))throw new Error(localizedPair(language, '没有可核查的旧质押交易。', 'No recoverable old stake transaction.'));
   const opId=`bank:${address.toLowerCase()}:${saved.action.id}`;
   const check=await fetch(`/api/user/bank/status?operationId=${encodeURIComponent(opId)}`,{cache:'no-store'});
   if(check.status!==404)throw new Error(localizedPair(language, '后台仍有该订单或无法核实，禁止解除。', 'The operation exists or could not be verified.'));
   const [transaction,receipt]=await Promise.all([client.getTransaction({hash:saved.depositHash}).catch(()=>null),client.getTransactionReceipt({hash:saved.depositHash}).catch(()=>null)]);
   if(transaction||receipt)throw new Error(localizedPair(language, '链上发现原交易，不能解除，请先恢复入账。', 'Original transaction exists on-chain; recovery is required.'));
   // Preserve the original intent for manual reconciliation, even after releasing its browser lock.
   const archiveKey=`${key}:unbroadcast:${saved.action.id}`;
   localStorage.setItem(archiveKey,JSON.stringify({...saved,releasedAt:Date.now()}));
   localStorage.removeItem(key);setNeedsRecovery(false);
   setStatus(localizedPair(language, '未发现原交易及后台订单；旧浏览器锁定已解除。请先小额测试。', 'No transaction or server operation found. Old browser lock released; test a small amount first.'));
  }catch(e){setError(e instanceof Error?e.message:'Recovery failed');}
  finally{lock.current=false;setBusy(false);}
 }
 return {execute,releaseUnbroadcastStake,busy,error,status,txHash,needsRecovery};
}
