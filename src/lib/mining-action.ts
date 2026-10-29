import {isAddress,isHash,keccak256,toBytes,type Address,type Hash} from 'viem';
import {parseAmount} from './business-engine.ts';
export type MiningAction={kind:'PREPARE_MINING'|'CONFIRM_MINING';id:string;amount:string;referrerWallet?:string|null;txHash?:Hash};
export function normalizeMiningAction(value:unknown){
 if(!value||typeof value!=='object')throw new Error('Invalid mining request');
 const action=value as MiningAction;
 if(!['PREPARE_MINING','CONFIRM_MINING'].includes(action.kind)||!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(action.id))throw new Error('Invalid mining request');
 const amountAtomic=parseAmount(action.amount).toString();const parent=action.referrerWallet?.trim().toLowerCase()??null;
 if(parent&&!isAddress(parent))throw new Error('Invalid referrer');
 if(action.kind==='CONFIRM_MINING'&&!isHash(action.txHash??''))throw new Error('Invalid mining payment');
 const normalized={kind:action.kind,id:action.id,amountAtomic,referrerWallet:parent as Address|null,txHash:action.kind==='CONFIRM_MINING'?action.txHash!.toLowerCase() as Hash:null};
 return {...normalized,purpose:`mining:${keccak256(toBytes(JSON.stringify(normalized)))}`};
}
