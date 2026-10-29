import {smallAreaRewardBatch} from './mining-small-area';
import type {Address} from 'viem';
import {getCloudflareContext} from '@opennextjs/cloudflare';
import {serverDB} from './server-db';
import {BUSINESS} from '@/config/business';
import type {Position} from './business-engine';
import {miningRewardBatch} from './mining-rewards';
import {GUARD_MINING_BATCH,UPDATE_MINING_POSITION,INSERT_MINING_REWARD,UPSERT_MINING_REMAINDER} from './mining-storage';
// Keep purchases closed until the complete unchanged small-area policy is configured.
const SMALL_AREA_SETTLEMENT_READY=true;
export const MINING_POLICY_STATUS='event_settlement';
export function miningEnabled(){return SMALL_AREA_SETTLEMENT_READY&& Reflect.get(getCloudflareContext().env,'TESTNET_MINING_ENABLED')==='true'&&Reflect.get(getCloudflareContext().env,'TESTNET_MINING_POLICY_COMPLETE')==='true';}
export async function settleMiningSource(source:Address,now=Date.now()){
 const db=serverDB();
 const initial=await db.prepare('SELECT position_json FROM business_positions WHERE wallet_address=? AND chain_id=97').bind(source).first<{position_json:string}>();
 if(!initial)return {rewards:0};
 const current=JSON.parse(initial.position_json) as Position;
 if(current.miningCapped||now<current.updatedAt||now<=(current.miningUpdatedAt??current.updatedAt)||BigInt(current.miningPgr)===BigInt(0))return {rewards:0};
 const revision=await db.prepare('SELECT revision FROM mining_state WHERE singleton=1').first<{revision:number}>();
 // Restrict the snapshot to the source's ancestors and their descendant branches.
 // The complete descendant branches remain necessary for exact small-area ranking.
 // UNION (not UNION ALL) also prevents cycles from expanding forever.
 const scopeSql=`WITH RECURSIVE
 ancestors(wallet) AS (
  SELECT ? UNION SELECT r.parent_wallet FROM wallet_referrals r
  JOIN ancestors a ON r.wallet_address=a.wallet WHERE r.parent_wallet IS NOT NULL
 ),
 scope(wallet) AS (
  SELECT wallet FROM ancestors
  UNION
  SELECT r.wallet_address FROM wallet_referrals r JOIN scope s ON r.parent_wallet=s.wallet
 )`;
 const [path,stored,counts,remainderRows]=await Promise.all([
  db.prepare(scopeSql+' SELECT r.wallet_address AS wallet,r.parent_wallet AS parent FROM wallet_referrals r JOIN scope s ON s.wallet=r.wallet_address').bind(source).all<{wallet:string;parent:string|null}>(),
  db.prepare(scopeSql+' SELECT p.wallet_address,p.position_json,p.version FROM business_positions p JOIN scope s ON s.wallet=p.wallet_address WHERE p.chain_id=97').bind(source).all<{wallet_address:string;position_json:string;version:number}>(),
  db.prepare(`WITH RECURSIVE ancestors(wallet,depth) AS (SELECT ?,0 UNION ALL SELECT r.parent_wallet,a.depth+1 FROM ancestors a JOIN wallet_referrals r ON r.wallet_address=a.wallet WHERE r.parent_wallet IS NOT NULL AND a.depth<10) SELECT r.parent_wallet,COUNT(*) count FROM wallet_referrals r JOIN mining_registry m ON m.wallet_address=r.wallet_address WHERE r.parent_wallet IN (SELECT wallet FROM ancestors WHERE depth>0) GROUP BY r.parent_wallet`).bind(source).all<{parent_wallet:string;count:number}>(),
  db.prepare('SELECT recipient_wallet,kind,remainder_atomic FROM mining_reward_remainders WHERE source_wallet=?').bind(source).all<{recipient_wallet:string;kind:string;remainder_atomic:string}>(),
 ]);
 // Measure the actual D1 snapshot size without logging wallet addresses or balances.
 if(stored.results.length>=1000)console.warn(JSON.stringify({event:'mining_snapshot_large',positions:stored.results.length,referrals:path.results.length}));
 const parents=new Map(path.results.map(r=>[r.wallet,r.parent]));
 const positions=new Map(stored.results.map(r=>[r.wallet_address,JSON.parse(r.position_json) as Position]));const position=positions.get(source);
 if(!position||position.miningCapped||now<position.updatedAt||now<=(position.miningUpdatedAt??position.updatedAt)||BigInt(position.miningPgr)===BigInt(0))return {rewards:0};
 const result=miningRewardBatch(source,now,{stakingBps:BUSINESS.stakingDailyRateBps,miningBps:BUSINESS.miningDailyRateBps},positions,parents,new Map(counts.results.map(r=>[r.parent_wallet,r.count])),new Map(remainderRows.results.map(r=>[`${r.recipient_wallet}:${r.kind}`,BigInt(r.remainder_atomic)])));
 const smallArea=smallAreaRewardBatch(source,now,BUSINESS.stakingDailyRateBps,result.positions,parents,result.rewards,result.remainders);
 result.positions=smallArea.positions;result.remainders=smallArea.remainders;result.rewards.push(...smallArea.rewards);
 const id=`mining:${source}:${result.from}:${now}`;
 const guards=stored.results.map(r=>({wallet:r.wallet_address,version:r.version}));
 const statements=[db.prepare(GUARD_MINING_BATCH).bind(id,source,result.from,now,revision?.revision??-1,JSON.stringify(guards))];
 for(const row of stored.results){const next=result.positions.get(row.wallet_address)!;if(JSON.stringify(next)===row.position_json)continue;statements.push(db.prepare(UPDATE_MINING_POSITION).bind(JSON.stringify(next),now,id,row.wallet_address,row.version,id));}
 for(const reward of result.rewards)statements.push(db.prepare(INSERT_MINING_REWARD).bind(`${id}:${reward.recipient}:${reward.kind}:${reward.generation}`,id,reward.recipient,source,reward.kind,reward.generation,reward.rateBps,reward.requested.toString(),reward.amount.toString(),result.from,now,now,id));
 for(const [key,value]of result.remainders){const [recipient,kind]=key.split(':');statements.push(db.prepare(UPSERT_MINING_REMAINDER).bind(source,recipient,kind,value.toString(),id));}
 await db.batch(statements);
 return {rewards:result.rewards.length};
}
export async function pumpMiningRewards(limit=5){
 if(!miningEnabled())return {miningProcessed:0};
 const rows=await serverDB().prepare(`SELECT wallet_address FROM business_positions WHERE chain_id=97 AND json_extract(position_json,'$.miningCapped')=0 AND CAST(json_extract(position_json,'$.miningPgr') AS INTEGER)>0 ORDER BY COALESCE(json_extract(position_json,'$.miningUpdatedAt'),updated_at),wallet_address LIMIT ?`).bind(limit).all<{wallet_address:Address}>();
 let miningProcessed=0;for(const row of rows.results){try{await settleMiningSource(row.wallet_address);miningProcessed++;}catch(e){console.error(JSON.stringify({event:'mining_settlement_retry',error:e instanceof Error?e.name:'UnknownError'}));}}
 return {miningProcessed};
}
