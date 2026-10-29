import {creditMiningReward,settleStaking,type Position} from './business-engine.ts';
import {smallAreaTier,type MiningReward} from './mining-rewards.ts';
export function smallAreaTeams(positions:Map<string,Position>,parents:Map<string,string|null>){
 const teams=new Map<string,Map<string,bigint>>(),branchTimes=new Map<string,Map<string,number>>(),totals=new Map<string,{value:bigint;reachedAt:number}>(),pending=new Map<string,number>();
 for(const [wallet,position]of positions){
  const value=position.miningCapped?BigInt(0):BigInt(position.miningPgr)/BigInt(2);
  const active=(position.miningCycles??[]).filter(c=>!c.capped&&BigInt(c.principalPgr)>BigInt(0));
  const reachedAt=value>BigInt(0)?Math.max(...(active.length?active.map(c=>c.startedAt):[position.miningUpdatedAt??position.updatedAt])):0;
  totals.set(wallet,{value,reachedAt});
 }
 for(const [wallet,parent]of parents){if(!totals.has(wallet))totals.set(wallet,{value:BigInt(0),reachedAt:0});if(parent){if(!totals.has(parent))totals.set(parent,{value:BigInt(0),reachedAt:0});const branches=teams.get(parent)??new Map<string,bigint>();branches.set(wallet,BigInt(0));teams.set(parent,branches);const times=branchTimes.get(parent)??new Map<string,number>();times.set(wallet,0);branchTimes.set(parent,times);pending.set(parent,(pending.get(parent)??0)+1);}}
 // Fold each subtree once instead of walking every position through all ancestors.
 const leaves=[...totals.keys()].filter(wallet=>!pending.get(wallet));let processed=0;
 for(let index=0;index<leaves.length;index++){const wallet=leaves[index],parent=parents.get(wallet);processed++;if(!parent)continue;const capital=totals.get(wallet)!;teams.get(parent)!.set(wallet,capital.value);branchTimes.get(parent)!.set(wallet,capital.reachedAt);const parentTotal=totals.get(parent)!;totals.set(parent,{value:parentTotal.value+capital.value,reachedAt:capital.value>BigInt(0)?Math.max(parentTotal.reachedAt,capital.reachedAt):parentTotal.reachedAt});const left=pending.get(parent)!-1;pending.set(parent,left);if(left===0)leaves.push(parent);}
 if(processed!==totals.size)throw new Error('Referral cycle');
 return new Map(Array.from(teams,([wallet,branches])=>{
  let largeBranch:string|null=null,largest=BigInt(-1),largeReachedAt=Number.MAX_SAFE_INTEGER,total=BigInt(0);const times=branchTimes.get(wallet)!;
  for(const [branch,value]of [...branches].sort(([a],[b])=>a.localeCompare(b))){const reachedAt=times.get(branch)??0;total+=value;if(value>largest||(value===largest&&(reachedAt<largeReachedAt||(reachedAt===largeReachedAt&&(largeBranch===null||branch.localeCompare(largeBranch)<0))))){largeBranch=branch;largest=value;largeReachedAt=reachedAt;}}
  return [wallet,{branches,branchReachedAt:times,largeBranch,largeReachedAt,smallPerformance:total-(largest>BigInt(0)?largest:BigInt(0))}];
 }));
}
// Each new MINING / DOWNLINE / UPPER credit is a base once. Small-area payouts do not become another base.
export function smallAreaRewardBatch(source:string,now:number,stakingBps:number,positions:Map<string,Position>,parents:Map<string,string|null>,baseRewards:MiningReward[],previousRemainders:Map<string,bigint>){
 if(!baseRewards.some(reward=>reward.kind!=='SMALL_AREA'&&reward.amount>BigInt(0)&&parents.get(reward.recipient)))return {positions:new Map(positions),remainders:new Map(previousRemainders),rewards:[] as MiningReward[]};
 const teams=smallAreaTeams(positions,parents),bases=new Map<string,bigint>();
 for(const reward of baseRewards){
  if(reward.kind==='SMALL_AREA'||reward.amount===BigInt(0))continue;
  const seen=new Set([reward.recipient]);let branch=reward.recipient,parent=parents.get(branch);
  while(parent){
   if(seen.has(parent))throw new Error('Referral cycle');seen.add(parent);
   const team=teams.get(parent);if(team&&branch!==team.largeBranch&&smallAreaTier(team.smallPerformance)>0)bases.set(parent,(bases.get(parent)??BigInt(0))+reward.amount);
   branch=parent;parent=parents.get(parent);
  }
 }
 const next=new Map(positions),remainders=new Map(previousRemainders),rewards:MiningReward[]=[];
 for(const [recipient,base]of bases){
  const position=next.get(recipient);if(!position)continue;
  const rateBps=smallAreaTier(teams.get(recipient)!.smallPerformance),key=`${recipient}:SMALL_AREA`;
  const numerator=base*BigInt(rateBps)+(remainders.get(key)??BigInt(0)),requested=numerator/BigInt(10000);
  const credit=creditMiningReward(settleStaking(position,now,stakingBps),requested);
  next.set(recipient,credit.position);remainders.set(key,credit.position.miningCapped||BigInt(credit.position.miningPgr)===BigInt(0)?BigInt(0):numerator%BigInt(10000));
  rewards.push({source,recipient,kind:'SMALL_AREA',generation:0,rateBps,requested,amount:credit.allowed});
 }
 return {positions:next,remainders,rewards};
}
