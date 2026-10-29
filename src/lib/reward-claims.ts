import type { Address, Hash, Hex } from 'viem';

/** Legacy chain-97 minting claims are retired from the mainnet-only deployment. */
type Asset = 'PGR' | 'SOV';
export function issuerConfigured(): boolean { return false; }
export async function confirmClaim(_wallet: Address, _id: Hex, _hash: Hash): Promise<never> {
  throw new Error('MAINNET_REWARD_CLAIMS_NOT_READY');
}
export async function issueClaim(_wallet: Address, _asset: Asset): Promise<never> {
  throw new Error('MAINNET_REWARD_CLAIMS_NOT_READY');
}
