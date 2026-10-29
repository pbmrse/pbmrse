import {getCloudflareContext} from '@opennextjs/cloudflare';
import {authenticateWallet,type WalletProof} from '@/lib/wallet-auth';
import {normalizeMainnetClaimAction} from '@/lib/mainnet-claim-action';
import {confirmMainnetClaim,issueMainnetClaim,reconcileMainnetClaim} from '@/lib/mainnet-reward-claims';
import {assertMainnetPgrClaimAccess} from '@/lib/mainnet-stake-test-gate';
type Body=WalletProof&{chainId?:number;action?:unknown};
export async function POST(request:Request){
 const env=getCloudflareContext().env;
 if(Reflect.get(env,'MAINNET_FINANCIAL_MODE')!=='enabled')return Response.json({error:'MAINNET_FINANCIAL_ROUTE_NOT_READY'},{status:503,headers:{'Cache-Control':'no-store'}});
 let body:Body;try{body=await request.json() as Body;}catch{return Response.json({error:'INVALID_JSON'},{status:400});}
 if(body.chainId!==56||Reflect.get(env,'APP_NETWORK')!=='bsc-mainnet')return Response.json({error:'MAINNET_NETWORK_REQUIRED'},{status:400,headers:{'Cache-Control':'no-store'}});
 let action:ReturnType<typeof normalizeMainnetClaimAction>;try{action=normalizeMainnetClaimAction(body.action);}catch{return Response.json({error:'INVALID_CLAIM_ACTION'},{status:400,headers:{'Cache-Control':'no-store'}});}
 let wallet;try{wallet=await authenticateWallet(body,action.purpose);}catch{return Response.json({error:'WALLET_AUTH_FAILED'},{status:401,headers:{'Cache-Control':'no-store'}});}
 try{assertMainnetPgrClaimAccess(env as Record<string,unknown>,wallet,action.kind,action.asset);}catch{return Response.json({error:'MAINNET_REWARD_TEST_GATE_REJECTED'},{status:403,headers:{'Cache-Control':'no-store'}});}
 try{return Response.json(action.kind==='ISSUE'?await issueMainnetClaim(wallet,action.asset):action.kind==='RECOVER'?await reconcileMainnetClaim(wallet,action.claimId):await confirmMainnetClaim(wallet,action.claimId,action.txHash),{headers:{'Cache-Control':'no-store'}});}
 catch(error){console.error(JSON.stringify({event:'mainnet_claim_operation_failed',error:error instanceof Error?error.name:'UnknownError'}));return Response.json({error:error instanceof Error?error.message:'MAINNET_CLAIM_UNAVAILABLE'},{status:503,headers:{'Cache-Control':'no-store'}});}
}
