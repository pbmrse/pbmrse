// All stored and calculated asset amounts are 18-decimal integers.
export const UNIT = BigInt('1000000000000000000');
const BPS = BigInt(10000); const DAY_MS = BigInt(86400000);
export type MiningCycle = { id:string; principalPgr:string; startedAt:number; lastSettledAt:number; staticEarned:string; staticRemainder:string; dynamicEarned:string; totalEarned:string; capSov:string; capped:boolean; };

export type Position = {
  stakePrincipal: string; stakePending: string; stakeRemainder: string;
  miningPgr: string; miningPending: string; miningRemainder: string;
  miningEarned: string; miningCapitalPgr: string; miningCapped: boolean; miningCycle: number; miningCycles?: MiningCycle[];
  updatedAt: number; miningUpdatedAt?: number;
};
export type Rates = { stakingBps: number; miningBps: number };
export function freshPosition(now: number): Position {
  return { stakePrincipal:'0',stakePending:'0',stakeRemainder:'0',miningPgr:'0',miningPending:'0',miningRemainder:'0',miningEarned:'0',miningCapitalPgr:'0',miningCapped:false,miningCycle:0,miningCycles:[],updatedAt:now };
}
export function parseAmount(value: unknown): bigint {
  if (typeof value !== 'string' || !/^\d{1,30}(\.\d{1,18})?$/.test(value.trim())) throw new Error('Invalid asset amount');
  const [whole, fraction=''] = value.trim().split('.');
  const amount=BigInt(whole)*UNIT+BigInt(fraction.padEnd(18,'0'));
  if (amount <= BigInt(0)) throw new Error('Amount must be positive'); return amount;
}
export function normalizeMiningCycles(position: Position): MiningCycle[] {
  if (position.miningCycles?.length) return position.miningCycles;
  const pgr=BigInt(position.miningPgr);
  if (pgr<=BigInt(0)||position.miningCapped) return [];
  const started=position.miningUpdatedAt??position.updatedAt;
  const cap=pgr*BigInt(3)/BigInt(2);
  const earned=BigInt(position.miningEarned);
  return [{id:`legacy:${position.miningCycle||0}`,principalPgr:pgr.toString(),startedAt:started,lastSettledAt:started,staticEarned:earned.toString(),staticRemainder:'0',dynamicEarned:'0',totalEarned:earned.toString(),capSov:cap.toString(),capped:earned>=cap}];
}
function syncMiningAggregate(position:Position,cycles:MiningCycle[]):Position {
  const active=cycles.filter(c=>!c.capped);
  const pgr=active.reduce((n,c)=>n+BigInt(c.principalPgr),BigInt(0));
  const earned=cycles.reduce((n,c)=>n+BigInt(c.totalEarned),BigInt(0));
  // Only active cycles consume the account's 6000-USDT-equivalent mining quota.
  const capital=pgr;
  return {...position,miningCycles:cycles,miningPgr:pgr.toString(),miningCapitalPgr:capital.toString(),miningEarned:earned.toString(),miningCapped:active.length===0,miningCycle:Math.max(position.miningCycle,...cycles.map(c=>Number(c.id.split(':').pop())||0))};
}
export function settle(position: Position, now: number, rates: Rates) {
  if (!Number.isSafeInteger(now) || now < position.updatedAt) throw new Error('Invalid settlement time');
  if (!Number.isInteger(rates.stakingBps) || rates.stakingBps < 0 || rates.stakingBps > 10000 || !Number.isInteger(rates.miningBps) || rates.miningBps < 80 || rates.miningBps > 120) throw new Error('Invalid reward rate');
  const next={...position}; const elapsed=BigInt(now-position.updatedAt);
  const stakeNumerator=BigInt(next.stakePrincipal)*BigInt(2)*BigInt(rates.stakingBps)*elapsed+BigInt(next.stakeRemainder);
  const stakeDenominator=BPS*DAY_MS;
  const stakeReward=stakeNumerator/stakeDenominator;
  next.stakePending=(BigInt(next.stakePending)+stakeReward).toString();
  next.stakeRemainder=(stakeNumerator%stakeDenominator).toString();
  let miningReward=BigInt(0);
  let cycles=normalizeMiningCycles(next);
  cycles=cycles.map(c=>{
    if(c.capped)return c;
    const elapsedMs=BigInt(Math.max(0,now-c.lastSettledAt));
    const numerator=BigInt(c.principalPgr)*BigInt(rates.miningBps)*elapsedMs+BigInt(c.staticRemainder||'0');
    const denominator=BigInt(2)*BPS*DAY_MS;
    const reward=numerator/denominator;
    const remainder=numerator%denominator;
    const remaining=BigInt(c.capSov)-BigInt(c.totalEarned);
    const allowed=reward<remaining?reward:remaining;
    miningReward+=allowed;
    const total=BigInt(c.totalEarned)+allowed;
    return {...c,staticEarned:(BigInt(c.staticEarned)+allowed).toString(),staticRemainder:remainder.toString(),totalEarned:total.toString(),lastSettledAt:now,capped:total>=BigInt(c.capSov)};
  });
  const after=syncMiningAggregate(next,cycles);
  if(miningReward>BigInt(0))after.miningPending=(BigInt(after.miningPending)+miningReward).toString();
  after.updatedAt=now; after.miningUpdatedAt=now;
  return {position:after,stakeReward,miningReward};
}
// Staking writes cannot consume mining accrual before its referral batch is recorded.
export function settleStaking(position:Position,now:number,stakingBps:number):Position{
  if (!Number.isSafeInteger(now) || now < position.updatedAt) throw new Error('Invalid settlement time');
  if (!Number.isInteger(stakingBps) || stakingBps < 0 || stakingBps > 10000) throw new Error('Invalid staking rate');
  const elapsed=BigInt(now-position.updatedAt);
  const numerator=BigInt(position.stakePrincipal)*BigInt(2)*BigInt(stakingBps)*elapsed+BigInt(position.stakeRemainder);
  const denominator=BPS*DAY_MS;
  return {...position,stakePending:(BigInt(position.stakePending)+numerator/denominator).toString(),stakeRemainder:(numerator%denominator).toString(),updatedAt:now};
}
export function stake(position: Position, amount: bigint, hasReferrer: boolean) {
  if (amount<=BigInt(0)) throw new Error('Invalid stake');
  const commission=hasReferrer?amount*BigInt(200)/BPS:BigInt(0);
  const principal=amount; // Full USDT deposit is credited; referral PGR is platform-funded.
  return {position:{...position,stakePrincipal:(BigInt(position.stakePrincipal)+principal).toString()},commission,principal};
}
export function cancellationPayout(amount: bigint) {
  if (amount <= 0n) throw new Error('Invalid cancellation amount');
  const fee = amount * 200n / BPS;
  return { fee, returned: amount - fee };
}
export function cancelStake(position: Position, amount: bigint) {
  if(amount<=BigInt(0)||amount>BigInt(position.stakePrincipal)) throw new Error('Invalid cancellation amount');
  const { fee, returned } = cancellationPayout(amount);
  return {position:{...position,stakePrincipal:(BigInt(position.stakePrincipal)-amount).toString()},fee,returned};
}
export function purchaseMining(position: Position, amount: bigint, now=Date.now()) {
  if(amount<BigInt(1000)*UNIT) throw new Error('Mining purchase requires at least 1000 PGR (500 USDT)');
  const allCycles=normalizeMiningCycles(position);
  const existing=allCycles.filter(c=>!c.capped);
  const active=existing.reduce((n,c)=>n+BigInt(c.principalPgr),BigInt(0));
  if(active+amount>BigInt(12000)*UNIT) throw new Error('Mining investment cannot exceed 12000 PGR (6000 USDT)');
  const nextCycleNo=position.miningCycle+1;
  const cycle:MiningCycle={id:`cycle:${nextCycleNo}`,principalPgr:amount.toString(),startedAt:now,lastSettledAt:now,staticEarned:'0',staticRemainder:'0',dynamicEarned:'0',totalEarned:'0',capSov:(amount*BigInt(3)/BigInt(2)).toString(),capped:false};
  return syncMiningAggregate(position,[...allCycles.filter(c=>c.capped),...existing,cycle]);
}
// Every mining/referral SOV credit shares the recipient's mining cap.
export function creditMiningReward(position: Position, amount: bigint) {
  if(amount<BigInt(0)) throw new Error('Invalid reward');
  if(amount===BigInt(0)) return {position,allowed:BigInt(0)};
  const all=normalizeMiningCycles(position);
  let active=all.filter(c=>!c.capped);
  if(!active.length) return {position,allowed:BigInt(0)};
  let remaining=amount;
  const allocations=new Map<string,bigint>();
  // Allocate by active principal weight. If a cycle hits its cap, redistribute
  // the unallocatable remainder among the cycles that still have capacity.
  while(remaining>BigInt(0)&&active.length){
    const totalPrincipal=active.reduce((n,c)=>n+BigInt(c.principalPgr),BigInt(0));
    let distributed=BigInt(0);
    for(const c of active){
      const weight=BigInt(c.principalPgr);
      const share=(remaining*weight)/totalPrincipal;
      if(share<=BigInt(0)) continue;
      const already=allocations.get(c.id)||BigInt(0);
      const room=BigInt(c.capSov)-BigInt(c.totalEarned)-already;
      const add=share<room?share:room;
      if(add>BigInt(0)){ allocations.set(c.id,already+add); distributed+=add; }
    }
    if(distributed===BigInt(0)){
      // Integer rounding: give one smallest unit to the first cycle with room.
      let gave=false;
      for(const c of active){ const already=allocations.get(c.id)||BigInt(0); if(BigInt(c.capSov)-BigInt(c.totalEarned)-already>BigInt(0)){ allocations.set(c.id,already+BigInt(1)); distributed=BigInt(1); gave=true; break; } }
      if(!gave) break;
    }
    remaining-=distributed;
    active=active.filter(c=>(BigInt(c.capSov)-BigInt(c.totalEarned)-(allocations.get(c.id)||BigInt(0)))>BigInt(0));
  }
  const allowedTotal=amount-remaining;
  const next=all.map(c=>{
    const add=allocations.get(c.id)||BigInt(0);
    if(add===BigInt(0)) return c;
    const total=BigInt(c.totalEarned)+add;
    return {...c,dynamicEarned:(BigInt(c.dynamicEarned)+add).toString(),totalEarned:total.toString(),capped:total>=BigInt(c.capSov)};
  });
  const synced=syncMiningAggregate({...position,miningPending:(BigInt(position.miningPending)+allowedTotal).toString()},next);
  return {allowed:allowedTotal,position:synced};
}
