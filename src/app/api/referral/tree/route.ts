import {isAddress} from 'viem';
import {serverDB} from '@/lib/server-db';
export async function GET(request:Request){
 try{
  const wallet=new URL(request.url).searchParams.get('wallet')?.trim().toLowerCase();if(!wallet||!isAddress(wallet))return Response.json({error:'Invalid wallet address'},{status:400});
  const db=serverDB();
  const rows=await db.prepare(`WITH RECURSIVE team(wallet,generation) AS (
   SELECT wallet_address,1 FROM wallet_referrals WHERE parent_wallet=?
   UNION ALL SELECT r.wallet_address,t.generation+1 FROM wallet_referrals r JOIN team t ON r.parent_wallet=t.wallet WHERE t.generation<10
  ) SELECT wallet,generation,(SELECT COUNT(*) FROM wallet_referrals r JOIN mining_registry m ON m.wallet_address=r.wallet_address WHERE r.parent_wallet=team.wallet) AS directReferrals,EXISTS(SELECT 1 FROM mining_registry m WHERE m.wallet_address=team.wallet) AS miningQualified FROM team ORDER BY generation,wallet`).bind(wallet).all<{wallet:string;generation:number;directReferrals:number;miningQualified:number}>();
  const direct=rows.results.filter(x=>x.generation===1&&x.miningQualified).length;const generations=Array.from({length:10},(_,i)=>({generation:i+1,members:rows.results.filter(x=>x.generation===i+1).map(x=>({wallet:x.wallet,directReferrals:x.directReferrals,miningQualified:!!x.miningQualified}))})).filter(x=>x.members.length);
  return Response.json({wallet,directReferrals:direct,maxGenerations:Math.min(direct,10),upperUnlocked:direct>=5,generations},{headers:{'Cache-Control':'no-store'}});
 }catch{return Response.json({error:'Unable to load referral tree'},{status:503});}
}
