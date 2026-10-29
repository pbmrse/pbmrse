import { authenticateWallet, type WalletProof } from '@/lib/wallet-auth';
import { serverDB } from '@/lib/server-db';
import { formatUnits,isAddress } from 'viem';
import {sessionWallet} from '@/lib/read-session';

export async function POST(request: Request) {
  try {
    const body = await request.json() as WalletProof & { chainId?: number };
    if (body.chainId !== 56) return Response.json({ error: 'Unsupported chain' }, { status: 400 });
    let wallet: string;
    try { wallet = await authenticateWallet(body, 'account'); }
    catch { return Response.json({ error: 'Wallet authorization failed' }, { status: 401 }); }
    return await accountSnapshot(wallet,body.chainId);
  } catch { return Response.json({ error: 'Unable to load backend account' }, { status: 503 }); }
}

async function accountSnapshot(wallet:string,chainId:number){
    const db = serverDB();
    const [balanceRows, entryRows] = await Promise.all([
      db.prepare('SELECT asset, SUM(CAST(amount_atomic AS INTEGER)) AS total FROM wallet_ledger WHERE wallet_address=? AND chain_id=? GROUP BY asset')
        .bind(wallet, chainId).all<{asset:'USDT'|'PGR'|'SOV';total:string|number}>(),
      db.prepare('SELECT id,asset,amount_atomic,entry_type,source_key,created_at FROM wallet_ledger WHERE wallet_address=? AND chain_id=? ORDER BY id DESC LIMIT 100')
        .bind(wallet, chainId).all<{ id: number; asset: 'USDT' | 'PGR' | 'SOV'; amount_atomic: string; entry_type: string; source_key: string; created_at: number }>(),
    ]);
    const balances = { USDT: BigInt(0), PGR: BigInt(0), SOV: BigInt(0) };
    for (const row of balanceRows.results) balances[row.asset] = BigInt(row.total);
    return Response.json({ walletAddress: wallet, chainId,
      balances: Object.fromEntries(Object.entries(balances).map(([asset, amount]) => [asset, { atomic: amount.toString(), formatted: formatUnits(amount, 18) }])),
      entries: entryRows.results, legacyBalancesIncluded: false,
    }, { headers: { 'Cache-Control': 'no-store' } });
}
export async function GET(request:Request){
 try{
  const wallet=await sessionWallet(request),requested=new URL(request.url).searchParams.get('walletAddress');
  if(!wallet||!requested||!isAddress(requested)||requested.toLowerCase()!==wallet.toLowerCase())return Response.json({error:'Wallet authorization failed'},{status:401,headers:{'Cache-Control':'no-store'}});
  return await accountSnapshot(wallet,56);
 }catch{return Response.json({error:'Unable to load backend account'},{status:503,headers:{'Cache-Control':'no-store'}});}
}
