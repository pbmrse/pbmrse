import {isHash,keccak256,toBytes,type Hash,type Hex} from 'viem';
export type MainnetClaimAction={asset:'PGR'|'SOV';claimId?:Hex;txHash?:Hash};
export function normalizeMainnetClaimAction(value:unknown){
 if(!value||typeof value!=='object')throw new Error('INVALID_CLAIM_ACTION');const action=value as MainnetClaimAction;
 if(action.asset!=='PGR'&&action.asset!=='SOV')throw new Error('INVALID_CLAIM_ASSET');
 if(action.claimId===undefined&&action.txHash!==undefined)throw new Error('INVALID_CLAIM_CONFIRMATION');
 if(action.claimId!==undefined&&!isHash(action.claimId))throw new Error('INVALID_CLAIM_CONFIRMATION');
 if(action.txHash!==undefined&&!isHash(action.txHash))throw new Error('INVALID_CLAIM_CONFIRMATION');
 const normalized=action.claimId===undefined
  ?{chainId:56,kind:'ISSUE' as const,asset:action.asset}
  :action.txHash===undefined
   ?{chainId:56,kind:'RECOVER' as const,asset:action.asset,claimId:action.claimId.toLowerCase() as Hex}
   :{chainId:56,kind:'CONFIRM' as const,asset:action.asset,claimId:action.claimId.toLowerCase() as Hex,txHash:action.txHash.toLowerCase() as Hash};
 return {...normalized,purpose:`mainnet-claim:${keccak256(toBytes(JSON.stringify(normalized)))}`};
}
