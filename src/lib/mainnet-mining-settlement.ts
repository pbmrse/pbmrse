import {smallAreaRewardBatch} from './mining-small-area';
import type {Address} from 'viem';
import {getCloudflareContext} from '@opennextjs/cloudflare';
import {serverDB} from './server-db';
import {BUSINESS} from '@/config/business';
import type {Position} from './business-engine';
import {miningRewardBatch} from './mining-rewards';
import {GUARD_MINING_BATCH,UPDATE_MINING_POSITION,INSERT_MINING_REWARD,UPSERT_MINING_REMAINDER} from './mainnet-mining-storage';
// Keep purchases closed until the complete unchanged small-area policy is configured.
const SMALL_AREA_SETTLEMENT_READY=true;
export const MINING_POLICY_STATUS='event_settlement';
export function mainnetMiningEnabled(){return SMALL_AREA_SETTLEMENT_READY&& Reflect.get(getCloudflareContext().env,'APP_NETWORK')==='bsc-mainnet'&& Reflect.get(getCloudflareContext().env,'MAINNET_FINANCIAL_MODE')==='enabled'&& Reflect.get(getCloudflareContext().env,'MAINNET_MINING_ENABLED')==='true'&&Reflect.get(getCloudflareContext().env,'MAINNET_MINING_POLICY_COMPLETE')==='true';}
export async function settleMainnetMiningSource(source:Address,now=Date.now()){
 if (Reflect.get(getCloudflareContext().env, 'APP_NETWORK') !== 'bsc-mainnet') {
  throw new Error('Mainnet mining settlement requires the mainnet Worker');
 }
 if (!mainnetMiningEnabled()) throw new Error('Mainnet mining is disabled');
 const db=serverDB();
 const initial=await db.prepare('SELECT position_json FROM business_positions WHERE wallet_address=? AND chain_id=56').bind(source).first<{position_json:string}>();
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
  db.prepare(scopeSql+' SELECT p.wallet_address,p.position_json,p.version FROM business_positions p JOIN scope s ON s.wallet=p.wallet_address WHERE p.chain_id=56').bind(source).all<{wallet_address:string;position_json:string;version:number}>(),
  db.prepare(`WITH RECURSIVE ancestors(wallet,depth) AS (SELECT ?,0 UNION ALL SELECT r.parent_wallet,a.depth+1 FROM ancestors a JOIN wallet_referrals r ON r.wallet_address=a.wallet WHERE r.parent_wallet IS NOT NULL AND a.depth<10) SELECT r.parent_wallet,COUNT(*) count FROM wallet_referrals r JOIN mining_registry m ON m.wallet_address=r.wallet_address JOIN business_positions active ON active.wallet_address=r.wallet_address AND active.chain_id=56 AND json_extract(active.position_json,'$.miningCapped')=0 AND json_type(active.position_json,'$.miningPgr')='text' AND json_extract(active.position_json,'$.miningPgr') NOT GLOB '*[^0-9]*' AND ltrim(json_extract(active.position_json,'$.miningPgr'),'0') GLOB '[1-9]*' WHERE r.parent_wallet IN (SELECT wallet FROM ancestors WHERE depth>0) GROUP BY r.parent_wallet`).bind(source).all<{parent_wallet:string;count:number}>(),
  db.prepare('SELECT recipient_wallet,kind,remainder_atomic FROM mining_reward_remainders WHERE source_wallet=?').bind(source).all<{recipient_wallet:string;kind:string;remainder_atomic:string}>(),
 ]);
 // Measure the actual D1 snapshot size without logging wallet addresses or balances.
 if(stored.results.length>=1000)console.warn(JSON.stringify({event:'mining_snapshot_large',positions:stored.results.length,referrals:path.results.length}));
 if(path.results.length>=1000||stored.results.length>=1000||counts.results.length>=1000||remainderRows.results.length>=1000)throw new Error('Mining settlement snapshot exceeds safe D1 page size; reconciliation required');
 if(new Set(path.results.map(r=>r.wallet.toLowerCase())).size!==path.results.length||new Set(stored.results.map(r=>r.wallet_address.toLowerCase())).size!==stored.results.length||new Set(counts.results.map(r=>r.parent_wallet.toLowerCase())).size!==counts.results.length||new Set(remainderRows.results.map(r=>`${r.recipient_wallet.toLowerCase()}:${r.kind}`)).size!==remainderRows.results.length)throw new Error('Mining settlement snapshot contains duplicate identities; reconciliation required');
 const parents=new Map(path.results.map(r=>[r.wallet,r.parent]));
 const positions=new Map(stored.results.map(r=>[r.wallet_address,JSON.parse(r.position_json) as Position]));const position=positions.get(source);
 if(!position||position.miningCapped||now<position.updatedAt||now<=(position.miningUpdatedAt??position.updatedAt)||BigInt(position.miningPgr)===BigInt(0))return {rewards:0};
 const result=miningRewardBatch(source,now,{stakingBps:BUSINESS.stakingDailyRateBps,miningBps:BUSINESS.miningDailyRateBps},positions,parents,new Map(counts.results.map(r=>[r.parent_wallet,r.count])),new Map(remainderRows.results.map(r=>[`${r.recipient_wallet}:${r.kind}`,BigInt(r.remainder_atomic)])));
 const smallArea=smallAreaRewardBatch(source,now,BUSINESS.stakingDailyRateBps,result.positions,parents,result.rewards,result.remainders);
 result.positions=smallArea.positions;result.remainders=smallArea.remainders;result.rewards.push(...smallArea.rewards);
 const id=`mining:${source}:${result.from}:${now}`;
 if (result.rewards.length>500 || stored.results.length>500 || result.remainders.size>500) throw new Error('Mining settlement batch exceeds safe size');
 if(!revision||!Number.isSafeInteger(revision.revision)||revision.revision<0)throw new Error('Mining referral revision unavailable; settlement requires reconciliation');
 const guards=stored.results.map(r=>({wallet:r.wallet_address,version:r.version}));
 const statements=[db.prepare(GUARD_MINING_BATCH).bind(id,source,result.from,now,revision.revision,JSON.stringify(guards))];
 let positionUpdates=0;
 for(const row of stored.results){const next=result.positions.get(row.wallet_address)!;if(JSON.stringify(next)===row.position_json)continue;statements.push(db.prepare(UPDATE_MINING_POSITION).bind(JSON.stringify(next),now,id,row.wallet_address,row.version,id));positionUpdates++;}
 for(const reward of result.rewards)statements.push(db.prepare(INSERT_MINING_REWARD).bind(`${id}:${reward.recipient}:${reward.kind}:${reward.generation}`,id,reward.recipient,source,reward.kind,reward.generation,reward.rateBps,reward.requested.toString(),reward.amount.toString(),result.from,now,now,id));
 for(const [key,value]of result.remainders){const [recipient,kind]=key.split(':');statements.push(db.prepare(UPSERT_MINING_REMAINDER).bind(source,recipient,kind,value.toString(),id));}
 const applied=await db.batch(statements);
 if(applied.length!==statements.length||applied.some(row=>!row.meta||!Number.isSafeInteger(row.meta.changes))||applied[0]?.meta.changes!==1||applied.slice(1,1+positionUpdates).some(row=>row.meta.changes!==1)||applied.slice(1+positionUpdates,1+positionUpdates+result.rewards.length).some(row=>row.meta.changes!==1)||applied.slice(1+positionUpdates+result.rewards.length).some(row=>row.meta.changes!==1))throw new Error('Mining settlement batch was not fully accepted');
 const committed=await db.prepare('SELECT batch_id FROM mining_settlement_batches WHERE batch_id=? AND guard_ok=1').bind(id).first<{batch_id:string}>();
 if(!committed)throw new Error('Mining settlement concurrency guard failed; retry from a fresh snapshot');
 const recorded=await db.prepare('SELECT COUNT(*) AS count FROM business_rewards WHERE batch_id=?').bind(id).first<{count:number}>();
 if(recorded?.count!==result.rewards.length)throw new Error('Mining settlement reward count mismatch; requires reconciliation');
 return {rewards:result.rewards.length};
}
export async function pumpMainnetMiningRewards(limit=5){
 if (!Number.isSafeInteger(limit) || limit<1 || limit>100) throw new Error('Invalid mining batch limit');
 if(!mainnetMiningEnabled())return {miningProcessed:0};
 const rows=await serverDB().prepare(`SELECT wallet_address FROM business_positions WHERE chain_id=56 AND json_extract(position_json,'$.miningCapped')=0 AND json_type(position_json,'$.miningPgr')='text' AND json_extract(position_json,'$.miningPgr') NOT GLOB '*[^0-9]*' AND ltrim(json_extract(position_json,'$.miningPgr'),'0') GLOB '[1-9]*' ORDER BY COALESCE(json_extract(position_json,'$.miningUpdatedAt'),updated_at),wallet_address LIMIT ?`).bind(limit).all<{wallet_address:Address}>();
 let miningProcessed=0;for(const row of rows.results){try{await settleMainnetMiningSource(row.wallet_address);miningProcessed++;}catch(e){console.error(JSON.stringify({event:'mining_settlement_retry',error:e instanceof Error?e.name:'UnknownError'}));}}
 return {miningProcessed};
}
