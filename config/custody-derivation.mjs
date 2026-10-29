// Public, immutable derivation parameters. A new version must use a distinct
// identifier so every fixed address remains reproducible.
export const CUSTODY_DERIVATION_VERSION = 'PBMRESERVES_HMAC_SHA256_V1';
export const CUSTODY_DERIVATION_COUNTER_LIMIT = 10;

export function custodyDerivationMessage(chainId, ownerWallet, counter) {
  return `PBMReserves/${chainId}/Deposit/v1/${ownerWallet.toLowerCase()}/${counter}`;
}
