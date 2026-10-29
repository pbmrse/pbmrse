import {isAddress} from 'viem';
import {serverDB} from '@/lib/server-db';
import {miningTeamStats} from '@/lib/mining-team';
// Reads confirmed referral relations; never binds or changes them.
export async function POST(request:Request){
 try{
  const {walletAddress}=await request.json() as {walletAddress?:string};const wallet=walletAddress?.trim().toLowerCase();
  if(!wallet||!isAddress(wallet))return Response.json({error:'Invalid wallet address'},{status:400});
  const db=serverDB();const row=await db.prepare('SELECT parent_wallet,confirmed_at FROM wallet_referrals WHERE wallet_address=?').bind(wallet).first<{parent_wallet:string|null;confirmed_at:number}>();
  const team=await db.prepare('SELECT COUNT(*) AS count FROM wallet_referrals WHERE parent_wallet=?').bind(wallet).first<{count:number}>();const count=team?.count??0;const mining=await db.prepare('SELECT COUNT(*) count FROM wallet_referrals r JOIN mining_registry m ON m.wallet_address=r.wallet_address WHERE r.parent_wallet=?').bind(wallet).first<{count:number}>();const qualified=mining?.count??0;
  const stats=await miningTeamStats(wallet,db);
  return Response.json({miningDirectReferrals:qualified,miningTeamPerformanceUsdt:stats.miningTeamPerformanceUsdt,referrerWallet:row?.parent_wallet??null,teamCount:stats.teamCount,directReferrals:qualified,stakingDirectReferrals:count,maxGenerations:Math.min(qualified,10),upperUnlocked:qualified>=5,createdAt:row?.confirmed_at??null},{headers:{'Cache-Control':'no-store'}});
 }catch{return Response.json({error:'Unable to load user profile'},{status:503});}
}
