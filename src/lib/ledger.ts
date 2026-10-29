const REFERRER_KEY = 'pbm_referrer_v1';
const RESET_KEY = 'pbm-testnet-reset-v2-20261011';
export function clearLegacyTestCache() {
  if (typeof window === 'undefined') return;
  try {
    if (localStorage.getItem(RESET_KEY)) return;
    for (const key of ['pbm_stakes_v1', 'pbm_mining_v2', 'pbm_swaps_v1', 'pbm_transfers_v1', REFERRER_KEY]) localStorage.removeItem(key);
    localStorage.setItem(RESET_KEY, 'done');
  } catch {}
}
export function getLockedReferrer(): string | null {
  clearLegacyTestCache();
  if (typeof window === 'undefined') return null;
  try { return localStorage.getItem(REFERRER_KEY); } catch { return null; }
}
export function lockReferrer(address: string): boolean {
  clearLegacyTestCache();
  if (typeof window === 'undefined' || !/^0x[a-fA-F0-9]{40}$/.test(address)) return false;
  try {
    const existing = localStorage.getItem(REFERRER_KEY);
    if (existing) return existing.toLowerCase() === address.toLowerCase();
    localStorage.setItem(REFERRER_KEY, address); return true;
  } catch { return false; }
}
