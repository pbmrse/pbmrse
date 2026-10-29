import { getCloudflareContext } from '@opennextjs/cloudflare';
import { applyMainnetMiningPurchase } from '@/lib/mainnet-mining-purchase';
import { businessSnapshot } from '@/lib/business-snapshot';
import { normalizeMiningAction } from '@/lib/mining-action';
import { authenticateWallet, type WalletProof } from '@/lib/wallet-auth';

type Body=WalletProof&{chainId?:number;action?:unknown};
export async function POST(request:Request){
 const env=getCloudflareContext().env;
 if(Reflect.get(env,'MAINNET_FINANCIAL_MODE')!=='enabled')return Response.json({error:'MAINNET_FINANCIAL_ROUTE_NOT_READY'},{status:503,headers:{'Cache-Control':'no-store'}});
 let body:Body;try{body=await request.json() as Body;}catch{return Response.json({error:'INVALID_JSON'},{status:400});}
 if(body.chainId!==56||Reflect.get(env,'APP_NETWORK')!=='bsc-mainnet')return Response.json({error:'MAINNET_NETWORK_REQUIRED'},{status:400,headers:{'Cache-Control':'no-store'}});
 let action:ReturnType<typeof normalizeMiningAction>;try{action=normalizeMiningAction(body.action);}catch{return Response.json({error:'INVALID_MINING_ACTION'},{status:400,headers:{'Cache-Control':'no-store'}});}
 let wallet;try{wallet=await authenticateWallet(body,action.purpose);}catch{return Response.json({error:'WALLET_AUTH_FAILED'},{status:401,headers:{'Cache-Control':'no-store'}});}
 try{const intent=await applyMainnetMiningPurchase(wallet,action);return Response.json({intent,snapshot:await businessSnapshot(wallet)},{headers:{'Cache-Control':'no-store'}});}
 catch(error){console.error(JSON.stringify({event:'mainnet_mining_operation_failed',error:error instanceof Error?error.name:'UnknownError'}));return Response.json({error:error instanceof Error?error.message:'MAINNET_MINING_UNAVAILABLE'},{status:503,headers:{'Cache-Control':'no-store'}});}
}
