export const BUSINESS = {
  pgrReferencePriceUSDT: 0.5,
  sovReferencePriceUSDT: 1,
  minMiningUSDT: 500,
  maxMiningUSDT: 6000,
  minStakeUSDT: 0,
  swapFeeBps: 100,
  minWithdrawUSDT: 50,
  stakingDailyRateBps: 50,
  stakingCancellationFeeBps: 200,
  miningDailyRateBps: 80,
  miningDailyRateMinBps: 80,
  miningDailyRateMaxBps: 120,
  miningMaxEarningsMultiple: 3,
  referralRatesBps: [1000,500,500,300,300,300,200,200,200,200],
  referralUpperRateBps: 500,
  referralDirectLimit: 10,
  referralUpperUnlockDirects: 5,
  referralMaxGenerations: 10,
  // USDT direct reward belongs to staking only; the referral tree belongs to mining.
  referralDirectUsdtRewardBps: 200,
  smallAreaTiers: [
    { performance: 30000, rateBps: 100 },
    { performance: 50000, rateBps: 150 },
    { performance: 100000, rateBps: 200 },
    { performance: 200000, rateBps: 250 },
    { performance: 500000, rateBps: 300 },
  ]
} as const;

export function formatPercentBps(bps: number) {
  return `${(bps / 100).toFixed(2)}%`;
}
