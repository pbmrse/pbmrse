export const REFERRAL_DIRECT_LIMIT = 10;
export const REFERRAL_UPPER_UNLOCK_DIRECTS = 5;
export const REFERRAL_MAX_GENERATIONS = 10;
export const REFERRAL_DIRECT_USDT_REWARD_BPS = 200;

export const SMALL_AREA_TIERS = [
  { performance: 500_000, rateBps: 300 },
  { performance: 200_000, rateBps: 250 },
  { performance: 100_000, rateBps: 200 },
  { performance: 50_000, rateBps: 150 },
  { performance: 30_000, rateBps: 100 },
] as const;

export type ReferralNode = {
  wallet: string;
  parent: string | null;
  generation: number;
};

export type ReferralPolicy = {
  directCount: number;
  maxGenerations: number;
  upperUnlocked: boolean;
};

export function getReferralPolicy(directCount: number): ReferralPolicy {
  const safe = Math.max(0, Math.min(REFERRAL_DIRECT_LIMIT, Math.floor(directCount)));
  return {
    directCount: safe,
    maxGenerations: Math.min(safe, REFERRAL_MAX_GENERATIONS),
    upperUnlocked: safe >= REFERRAL_UPPER_UNLOCK_DIRECTS,
  };
}

export function getSmallAreaRateBps(performance: number): number {
  const value = Math.max(0, performance);
  return SMALL_AREA_TIERS.find(t => value >= t.performance)?.rateBps ?? 0;
}

/**
 * Returns the ancestor path from a newly qualified source wallet.
 * generation=1 is the direct referrer.
 */
export function buildUpline(sourceWallet: string, parentOf: (wallet: string) => string | null): ReferralNode[] {
  const result: ReferralNode[] = [];
  const seen = new Set<string>();
  let current = parentOf(sourceWallet);
  let generation = 1;

  while (current && generation <= REFERRAL_MAX_GENERATIONS) {
    const normalized = current.toLowerCase();
    if (seen.has(normalized)) break;
    seen.add(normalized);
    result.push({ wallet: current, parent: parentOf(current), generation });
    current = parentOf(current);
    generation += 1;
  }
  return result;
}
