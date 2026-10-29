import {isAddress,isHash,keccak256,parseUnits,toBytes,type Address} from 'viem';
export type BankAction={kind:'STAKE'|'CANCEL_STAKE'|'WITHDRAW_USDT';id:string;amount:string;referrerWallet?:string|null;depositHash?:string|null};
export function normalizeBankAction(value:unknown){
 if(!value||typeof value!=='object')throw new Error('Invalid bank action');
 const action=value as Partial<BankAction>;
 if(!['STAKE','CANCEL_STAKE','WITHDRAW_USDT'].includes(action.kind||''))throw new Error('Invalid bank action');
 if(typeof action.id!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(action.id))throw new Error('Invalid operation identifier');
 if(typeof action.amount!=='string'||!/^\d{1,30}(\.\d{1,18})?$/.test(action.amount.trim()))throw new Error('Invalid asset amount');
 const amountAtomic=parseUnits(action.amount.trim(),18).toString();if(BigInt(amountAtomic)<=BigInt(0))throw new Error('Amount must be positive');
 const referrer=action.kind==='STAKE'&&action.referrerWallet?action.referrerWallet.trim().toLowerCase():null;
 if(referrer&&!isAddress(referrer))throw new Error('Invalid referrer');
 const depositHash=action.kind==='STAKE'&&action.depositHash?action.depositHash.toLowerCase():null;
 if(depositHash&&!isHash(depositHash))throw new Error('Invalid stake deposit hash');
 const normalized={kind:action.kind as BankAction['kind'],id:action.id,amountAtomic,referrerWallet:referrer as Address|null,...(depositHash?{depositHash}:{})};
 const digest=keccak256(toBytes(JSON.stringify(normalized)));
 return {...normalized,purpose:`bank:${digest}`};
}
