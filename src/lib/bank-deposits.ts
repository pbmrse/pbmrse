import type { Address, Hash } from 'viem';

/** Legacy testnet deposit confirmation is retired from the mainnet-only deployment. */
export async function confirmTestnetDeposit(_wallet: Address, _hash: Hash): Promise<never> {
  throw new Error('MAINNET_DEPOSIT_CONFIRMATION_NOT_READY');
}
