import {getCloudflareContext} from '@opennextjs/cloudflare';
import {authenticatedSignerRequest,validSignerCallerSecret,type SignerAudience} from './signer-service-auth';

type SignerBinding={fetch(request:Request):Promise<Response>};
type IdentityResult={matches:boolean};
type CustodyIdentityResult={rootMatches:boolean;gasMatches:boolean};

function envString(env:object,name:string){const value=Reflect.get(env,name);return typeof value==='string'&&value.length?value:undefined;}

async function check(bindingName:'TREASURY_SIGNER'|'REWARD_SIGNER',secretName:'TREASURY_SIGNER_CALLER_SECRET'|'REWARD_SIGNER_CALLER_SECRET',audience:SignerAudience,url:string):Promise<boolean>{
 const env=getCloudflareContext().env,secret=envString(env,secretName),binding=Reflect.get(env,bindingName) as SignerBinding|undefined;
 if(!validSignerCallerSecret(secret)||!binding||typeof binding.fetch!=='function')throw new Error('SIGNER_IDENTITY_BINDING_UNAVAILABLE');
 const request=await authenticatedSignerRequest(url,'{}',secret,audience);
 const response=await binding.fetch(request);
 if(!response.ok)throw new Error('SIGNER_IDENTITY_CHECK_REJECTED');
 const result=await response.json() as Partial<IdentityResult>;
 if(typeof result.matches!=='boolean'||Object.keys(result).length!==1)throw new Error('SIGNER_IDENTITY_RESPONSE_INVALID');
 return result.matches;
}

async function checkCustody(){
 const env=getCloudflareContext().env,secret=envString(env,'CUSTODY_SIGNER_CALLER_SECRET'),binding=Reflect.get(env,'CUSTODY_SIGNER') as SignerBinding|undefined;
 if(!validSignerCallerSecret(secret)||!binding||typeof binding.fetch!=='function')throw new Error('CUSTODY_SIGNER_IDENTITY_BINDING_UNAVAILABLE');
 const request=await authenticatedSignerRequest('https://custody-signer.internal/v1/identity','{}',secret,'pbmrse-custody-signer:v1');
 const response=await binding.fetch(request);if(!response.ok)throw new Error('CUSTODY_SIGNER_IDENTITY_CHECK_REJECTED');
 const result=await response.json() as Partial<CustodyIdentityResult>;
 if(typeof result.rootMatches!=='boolean'||typeof result.gasMatches!=='boolean'||Object.keys(result).length!==2)throw new Error('CUSTODY_SIGNER_IDENTITY_RESPONSE_INVALID');
 return result as CustodyIdentityResult;
}

export async function checkMainnetSignerIdentities(){
 const [treasury,reward,custody]=await Promise.all([
  check('TREASURY_SIGNER','TREASURY_SIGNER_CALLER_SECRET','pbmrse-treasury-signer:v1','https://treasury-signer.internal/v1/identity'),
  check('REWARD_SIGNER','REWARD_SIGNER_CALLER_SECRET','pbmrse-reward-signer:v1','https://reward-signer.internal/v1/identity'),
  checkCustody(),
 ]);
 return{treasury,reward,custodyRoot:custody.rootMatches,custodyGas:custody.gasMatches};
}
