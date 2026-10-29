'use client';
import {useEffect,useRef,useState} from 'react';
import {useAccount,useChainId,usePublicClient,useSignMessage,useWriteContract} from 'wagmi';
import {useQueryClient} from '@tanstack/react-query';
import type {Address,Hash,Hex} from 'viem';
import {MAINNET_CONTRACTS} from '@/lib/contracts-mainnet-client';
import {SIGNED_MINT_ABI} from '@/lib/mint-authorization';
export function useTokenClaim(asset:'PGR'|'SOV',onComplete:()=>void){
 const {address}=useAccount();const chainId=useChainId();const client=usePublicClient({chainId:56});
 const {signMessageAsync}=useSignMessage();const {writeContractAsync}=useWriteContract();const queryClient=useQueryClient();
 const [busy,setBusy]=useState(false);const [error,setError]=useState('');const [txHash,setTxHash]=useState<Hash>();const generation=useRef(0),lock=useRef(false);
 useEffect(()=>{generation.current++;lock.current=false;setBusy(false);setError('');setTxHash(undefined);return()=>{generation.current++;};},[address,chainId]);
 async function claim(){
  if(!address||chainId!==56||!client||lock.current)return;
  lock.current=true;
  const current=++generation.current;const same=()=>current===generation.current;
  setBusy(true);setError('');setTxHash(undefined);
  const post=async(path:string,body:unknown)=>{
   const response=await fetch(path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
   const result=await response.json();if(!response.ok)throw new Error(result.error||'Claim failed');return result;
  };
  const proof=async(action:{asset:'PGR'|'SOV';claimId?:Hex;txHash?:Hash})=>{
   const challenge=await post('/api/user/challenge',{walletAddress:address,purpose:'mainnet-claim',action});
   if(!same())throw new Error('Wallet changed');
   const signature=await signMessageAsync({account:address,message:challenge.message});
   if(!same())throw new Error('Wallet changed');
   return {walletAddress:address,chainId:56,action,nonce:challenge.nonce,signature};
  };
  const recoveryKey=`pbm-mainnet-claim:56:${address.toLowerCase()}:${asset}`;
  try{
   const saved=localStorage.getItem(recoveryKey) as Hex|null;
   if(saved){
    const recovered=await post('/api/user/claim',await proof({asset,claimId:saved}));if(!same())return;
    if(recovered.completed){if(recovered.txHash)setTxHash(recovered.txHash);localStorage.removeItem(recoveryKey);onComplete();await queryClient.invalidateQueries({queryKey:['v2-claims']});return;}
    throw new Error('Claim broadcast status is still unknown; retry reconciliation before sending again');
   }
   const issued=await post('/api/user/claim',await proof({asset}));if(!same())return;
   if(issued.completed){if(issued.txHash)setTxHash(issued.txHash);onComplete();await queryClient.invalidateQueries({queryKey:['v2-claims']});return;}
   let hash=issued.txHash as Hash|undefined;
   if(!hash){
    if(issued.chainId!==56||issued.token.toLowerCase()!==MAINNET_CONTRACTS[asset==='PGR'?'pgr':'sov'].toLowerCase()||issued.recipient.toLowerCase()!==address.toLowerCase())throw new Error('Invalid claim recipient');
    localStorage.setItem(recoveryKey,issued.claimId);
    try{hash=await writeContractAsync({account:address,chainId:56,address:issued.token as Address,abi:SIGNED_MINT_ABI,functionName:'mintWithAuthorization',args:[address,BigInt(issued.amount),issued.claimId as Hex,BigInt(issued.deadline),BigInt(issued.epoch),issued.signature as Hex]});}
    catch(e){if((e as {code?:number}).code===4001)localStorage.removeItem(recoveryKey);throw e;}
   }
   if(!same())return;setTxHash(hash);
   const receipt=await client.waitForTransactionReceipt({hash,confirmations:12,timeout:120000});
   if(receipt.status!=='success')throw new Error('Claim transaction reverted');
   if(!same())return;
   const confirmed=await post('/api/user/claim',await proof({asset,claimId:issued.claimId,txHash:hash}));
   if(!same())return;
   if(!confirmed.completed)throw new Error('Claim confirmation pending; retry to resume');
   localStorage.removeItem(recoveryKey);onComplete();await queryClient.invalidateQueries({queryKey:['v2-claims']});
  }catch(e){if(same())setError(e instanceof Error?e.message:'Unable to claim rewards');}
  finally{if(same()){lock.current=false;setBusy(false);}}
 }
 return {claim,busy,error,txHash};
}
