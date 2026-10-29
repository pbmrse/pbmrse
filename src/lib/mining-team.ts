import {formatUnits} from 'viem';
import {serverDB,type Database} from './server-db';
export async function miningTeamStats(wallet:string,db:Database=serverDB()){
 const rows=await db.prepare(`WITH RECURSIVE team(wallet) AS (
 SELECT wallet_address FROM wallet_referrals WHERE parent_wallet=?
 UNION SELECT r.wallet_address FROM wallet_referrals r JOIN team t ON r.parent_wallet=t.wallet
 ) SELECT t.wallet,p.position_json,EXISTS(SELECT 1 FROM mining_registry m WHERE m.wallet_address=t.wallet) AS qualified
 FROM team t LEFT JOIN business_positions p ON p.wallet_address=t.wallet AND p.chain_id=56 WHERE t.wallet<>?`).bind(wallet,wallet).all<{wallet:string;position_json:string|null;qualified:number}>();
 let performance=BigInt(0);
 for(const row of rows.results){
  if(!row.qualified||!row.position_json)continue;
  const position=JSON.parse(row.position_json) as {miningPgr:string;miningCapped?:boolean};
  if(!position.miningCapped)performance+=BigInt(position.miningPgr)/BigInt(2);
 }
 return {teamCount:rows.results.length,miningTeamPerformanceUsdt:formatUnits(performance,18)};
}
