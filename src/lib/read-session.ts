import {getCloudflareContext} from '@opennextjs/cloudflare';
import {isAddress,toBytes,type Address} from 'viem';
const name='pbm_read_56';
const encode=(data:Uint8Array)=>btoa(String.fromCharCode(...data)).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
const decode=(value:string)=>Uint8Array.from(atob(value.replace(/-/g,'+').replace(/_/g,'/')),c=>c.charCodeAt(0));
async function key(){const secret=Reflect.get(getCloudflareContext().env,'MAINNET_SESSION_KEY');if(typeof secret!=='string'||secret.length<32)throw new Error('Account session key unavailable');return crypto.subtle.importKey('raw',new Uint8Array(toBytes(secret)),{name:'HMAC',hash:'SHA-256'},false,['sign','verify']);}
export async function readSessionCookie(wallet:Address,scope:'user'|'admin'='user'){
 const seconds=scope==='admin'?900:300*24*60*60;
 const payload=encode(toBytes(JSON.stringify({wallet,chainId:56,scope,expiresAt:Date.now()+seconds*1000})));
 const signature=encode(new Uint8Array(await crypto.subtle.sign('HMAC',await key(),new Uint8Array(toBytes(payload)))));
 return `${name}=${payload}.${signature}; Path=/api/user; Max-Age=${seconds}; HttpOnly; Secure; SameSite=Strict`;
}
export async function sessionWallet(request:Request,requiredScope?:'admin'):Promise<Address|null>{
 try{
  const token=request.headers.get('cookie')?.split(';').map(v=>v.trim()).find(v=>v.startsWith(name+'='))?.slice(name.length+1);
  if(!token||token.length>1000)return null;const [payload,signature,...extra]=token.split('.');if(extra.length||!payload||!signature)return null;
  if(!await crypto.subtle.verify('HMAC',await key(),decode(signature),new Uint8Array(toBytes(payload))))return null;
  const data=JSON.parse(new TextDecoder().decode(decode(payload))) as {wallet:string;chainId:number;expiresAt:number;scope?:'user'|'admin'};
  if(requiredScope==='admin'&&data.scope!=='admin')return null;
  if(data.scope!==undefined&&data.scope!=='user'&&data.scope!=='admin')return null;
  const maxAge=data.scope==='user'?300*24*60*60*1000:15*60*1000;
  if(data.chainId!==56||!isAddress(data.wallet)||data.expiresAt<=Date.now()||data.expiresAt>Date.now()+maxAge+60*1000)return null;
  return data.wallet.toLowerCase() as Address;
 }catch{return null;}
}

export function clearReadSessionCookie(){return `${name}=; Path=/api/user; Max-Age=0; HttpOnly; Secure; SameSite=Strict`;}
