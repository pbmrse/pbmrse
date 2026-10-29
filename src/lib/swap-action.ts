import {isHash,parseUnits,type Hash} from 'viem';
import {BUSINESS} from '@/config/business';
export type SwapAction={kind:'PREPARE_SWAP'|'CONFIRM_SWAP';id:string;asset:'PGR'|'SOV';amount:string;txHash?:Hash};
export function mainnetSwapPurpose(action:{kind:'PREPARE_SWAP'|'CONFIRM_SWAP';id:string}){
 return `mainnet-swap:${action.kind}:${action.id}`;
}
export function swapQuote(asset:'PGR'|'SOV',amount:bigint){
 if(amount<=BigInt(0))throw new Error('Swap amount must be positive');
 const gross=amount/BigInt(asset==='PGR'?2:1),net=gross*BigInt(10000-BUSINESS.swapFeeBps)/BigInt(10000);
 if(net<=BigInt(0))throw new Error('Swap amount is too small');return {gross,fee:gross-net,net};
}
export function normalizeSwapAction(value:unknown){
 if(!value||typeof value!=='object')throw new Error('Invalid swap request');const a=value as SwapAction;
 if(!['PREPARE_SWAP','CONFIRM_SWAP'].includes(a.kind)||!['PGR','SOV'].includes(a.asset)||!(/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(a.id??'')))throw new Error('Invalid swap request');
 if(typeof a.amount!=='string'||!/^\d{1,30}(\.\d{1,18})?$/.test(a.amount.trim()))throw new Error('Invalid swap amount');const amountAtomic=parseUnits(a.amount.trim(),18).toString();swapQuote(a.asset,BigInt(amountAtomic));
 if(a.kind==='CONFIRM_SWAP'&&(!a.txHash||!isHash(a.txHash)))throw new Error('Original swap transaction hash required');
 return {kind:a.kind,id:a.id,asset:a.asset,amountAtomic,txHash:a.kind==='CONFIRM_SWAP'?a.txHash!.toLowerCase() as Hash:null};
}
