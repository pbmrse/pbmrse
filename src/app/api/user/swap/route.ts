import { getCloudflareContext } from '@opennextjs/cloudflare';
import { applyMainnetSwap } from '@/lib/mainnet-swap';
import { businessSnapshot } from '@/lib/business-snapshot';
import { mainnetSwapPurpose, normalizeSwapAction } from '@/lib/swap-action';
import { authenticateWallet, type WalletProof } from '@/lib/wallet-auth';
import {sessionWallet} from '@/lib/read-session';

type Body = WalletProof & { chainId?:number; action?:unknown; sessionRegistration?:boolean };

/** Chain-56 Swap endpoint. Every prepare/confirm request consumes a purpose-bound wallet signature. */
export async function POST(request:Request) {
  const env=getCloudflareContext().env;
  if(Reflect.get(env,'MAINNET_FINANCIAL_MODE')!=='enabled')return Response.json({error:'MAINNET_SWAP_NOT_READY'},{status:503,headers:{'Cache-Control':'no-store'}});
  let body:Body;
  try { body=await request.json() as Body; }
  catch { return Response.json({error:'INVALID_JSON'},{status:400}); }
  if(body.chainId!==56||Reflect.get(env,'APP_NETWORK')!=='bsc-mainnet'){
    return Response.json({error:'MAINNET_NETWORK_REQUIRED'},{status:400,headers:{'Cache-Control':'no-store'}});
  }
  let action:ReturnType<typeof normalizeSwapAction>;
  try { action=normalizeSwapAction(body.action); }
  catch { return Response.json({error:'INVALID_SWAP_ACTION'},{status:400,headers:{'Cache-Control':'no-store'}}); }
  let wallet;
  if(body.sessionRegistration===true&&action.kind==='CONFIRM_SWAP'){
    const session=await sessionWallet(request),requested=typeof body.walletAddress==='string'?body.walletAddress.toLowerCase():'';
    if(!session||session.toLowerCase()!==requested)return Response.json({error:'WALLET_AUTH_FAILED'},{status:401,headers:{'Cache-Control':'no-store'}});
    wallet=session;
  }else try { wallet=await authenticateWallet(body,mainnetSwapPurpose(action)); }
  catch { return Response.json({error:'WALLET_AUTH_FAILED'},{status:401,headers:{'Cache-Control':'no-store'}}); }
  try {
    const intent=await applyMainnetSwap(wallet,action);
    return Response.json({intent,snapshot:await businessSnapshot(wallet)},{headers:{'Cache-Control':'no-store'}});
  } catch(error) {
    const message=error instanceof Error?error.message:'MAINNET_SWAP_UNAVAILABLE';
    console.error(JSON.stringify({event:'mainnet_swap_operation_failed',error:error instanceof Error?error.name:'UnknownError'}));
    return Response.json({error:message},{status:503,headers:{'Cache-Control':'no-store'}});
  }
}
