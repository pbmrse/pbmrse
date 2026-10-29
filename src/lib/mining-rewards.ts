import {settle,settleStaking,creditMiningReward,type Position,type Rates} from './business-engine.ts';
export type MiningRewardKind='MINING'|'DOWNLINE'|'UPPER'|'SMALL_AREA';
export type MiningReward={source:string;recipient:string;kind:MiningRewardKind;generation:number;rateBps:number;requested:bigint;amount:bigint};
export const DOWNLINE_RATES=[1000,500,500,300,300,300,200,200,200,200] as const;
/** A source's actual mining output is the only referral base. Referral rewards never recurse. */
export function miningRewardBatch(source:string,now:number,rates:Rates,positions:Map<string,Position>,parents:Map<string,string|null>,directCounts:Map<string,number>,previousRemainders=new Map<string,bigint>()){
 const before=positions.get(source);if(!before)throw new Error('Mining source missing');
 const from=before.miningUpdatedAt??before.updatedAt;
 const own=settle(before,now,rates);const next=new Map(positions);next.set(source,own.position);
 const rewards:MiningReward[]=[];const remainders=new Map(previousRemainders);
 if(own.miningReward>BigInt(0))rewards.push({source,recipient:source,kind:'MINING',generation:0,rateBps:rates.miningBps,requested:own.miningReward,amount:own.miningReward});
 const seen=new Set([source]);let parent=parents.get(source);
 for(let generation=1;parent&&generation<=10;generation++){
  if(seen.has(parent))throw new Error('Referral cycle');seen.add(parent);
  const recipient=parent;const position=next.get(recipient);
  if(position&&own.miningReward>BigInt(0)){
   let current=settleStaking(position,now,rates.stakingBps);
   const count=directCounts.get(recipient)??0;
   const add=(kind:MiningRewardKind,rateBps:number)=>{
    const key=`${recipient}:${kind}`;const numerator=own.miningReward*BigInt(rateBps)+(remainders.get(key)??BigInt(0));
    const requested=numerator/BigInt(10000);
    const credit=creditMiningReward(current,requested);current=credit.position;
    remainders.set(key,current.miningCapped||BigInt(current.miningPgr)===BigInt(0)?BigInt(0):numerator%BigInt(10000));
    rewards.push({source,recipient,kind,generation,rateBps,requested,amount:credit.allowed});
   };
   if(count>=generation)add('DOWNLINE',DOWNLINE_RATES[generation-1]);
   if(generation===1&&count>=5)add('UPPER',500);
   next.set(recipient,current);
  }
  parent=parents.get(recipient);
 }
 return {from,to:now,positions:next,rewards,remainders};
}
export function smallAreaTier(performanceAtomic:bigint){
 const unit=BigInt('1000000000000000000');
 for(const [threshold,bps]of [[500000,300],[200000,250],[100000,200],[50000,150],[30000,100]])if(performanceAtomic>=BigInt(threshold)*unit)return bps;
 return 0;
}
