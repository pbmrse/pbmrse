import {bytesToHex,hexToBytes,toBytes,type Address,type Hex} from 'viem';
import {privateKeyToAccount} from 'viem/accounts';
import {CUSTODY_DERIVATION_COUNTER_LIMIT,CUSTODY_DERIVATION_VERSION,custodyDerivationMessage} from '../../config/custody-derivation.mjs';
// Bounded memoization of pure derivation; authorization and financial state are never cached.
export type CustodyDerivation={account:ReturnType<typeof privateKeyToAccount>;derivationVersion:string;derivationIndex:number};
const derivedAccounts=new Map<string,CustodyDerivation>();
export async function deriveCustodyRecord(root:Hex,wallet:Address,chainId:97|56=97):Promise<CustodyDerivation>{
 const cacheKey=chainId+':'+root.toLowerCase()+':'+wallet.toLowerCase(),cached=derivedAccounts.get(cacheKey);if(cached)return cached;
 const key=await crypto.subtle.importKey('raw',new Uint8Array(hexToBytes(root)),{name:'HMAC',hash:'SHA-256'},false,['sign']);
 for(let counter=0;counter<CUSTODY_DERIVATION_COUNTER_LIMIT;counter++){
  const digest=await crypto.subtle.sign('HMAC',key,new Uint8Array(toBytes(custodyDerivationMessage(chainId,wallet,counter))));
  try{const result={account:privateKeyToAccount(bytesToHex(new Uint8Array(digest))),derivationVersion:CUSTODY_DERIVATION_VERSION,derivationIndex:counter};if(derivedAccounts.size>=256)derivedAccounts.delete(derivedAccounts.keys().next().value!);derivedAccounts.set(cacheKey,result);return result;}catch{/* Reject the negligible number of invalid secp256k1 scalars. */}
 }
 throw new Error('Unable to derive custody account');
}
export async function deriveCustody(root:Hex,wallet:Address,chainId:97|56=97){return (await deriveCustodyRecord(root,wallet,chainId)).account;}
