import { isAddress } from 'viem';
import { authenticateWallet, type WalletProof } from '@/lib/wallet-auth';
import { businessSnapshot } from '@/lib/business-snapshot';
import { readSessionCookie, sessionWallet } from '@/lib/read-session';

export async function GET(request:Request) {
  const requested=new URL(request.url).searchParams.get('walletAddress')?.toLowerCase();
  const wallet=await sessionWallet(request);
  if(!wallet||!requested||!isAddress(requested)||wallet.toLowerCase()!==requested){
    return Response.json({error:'WALLET_AUTH_REQUIRED'},{status:401,headers:{'Cache-Control':'no-store'}});
  }
  try { return Response.json(await businessSnapshot(wallet),{headers:{'Cache-Control':'no-store'}}); }
  catch(error) {
    console.error(JSON.stringify({event:'mainnet_business_snapshot_failed',error:error instanceof Error?error.name:'UnknownError'}));
    return Response.json({error:'MAINNET_BUSINESS_ACCOUNT_UNAVAILABLE'},{status:503,headers:{'Cache-Control':'no-store'}});
  }
}

export async function POST(request:Request) {
  let body:WalletProof&{chainId?:number};
  try { body=await request.json() as WalletProof&{chainId?:number}; }
  catch { return Response.json({error:'INVALID_JSON'},{status:400}); }
  if(body.chainId!==56)return Response.json({error:'MAINNET_NETWORK_REQUIRED'},{status:400});
  let wallet;
  try { wallet=await authenticateWallet(body,'business'); }
  catch { return Response.json({error:'WALLET_AUTH_FAILED'},{status:401,headers:{'Cache-Control':'no-store'}}); }
  try {
    return Response.json(await businessSnapshot(wallet),{headers:{'Cache-Control':'no-store','Set-Cookie':await readSessionCookie(wallet)}});
  } catch(error) {
    console.error(JSON.stringify({event:'mainnet_business_snapshot_failed',error:error instanceof Error?error.name:'UnknownError'}));
    return Response.json({error:'MAINNET_BUSINESS_ACCOUNT_UNAVAILABLE'},{status:503,headers:{'Cache-Control':'no-store'}});
  }
}
