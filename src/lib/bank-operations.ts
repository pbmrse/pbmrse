import type { Address } from 'viem';
import type { normalizeBankAction } from './bank-action';

/** Legacy chain-97 ledger operations are retired from the mainnet-only deployment. */
export async function bankBalance(_wallet: Address): Promise<never> {
  throw new Error('MAINNET_BANK_OPERATIONS_NOT_READY');
}
export async function applyBankAction(_wallet: Address, _action: ReturnType<typeof normalizeBankAction>): Promise<never> {
  throw new Error('MAINNET_BANK_OPERATIONS_NOT_READY');
}
export async function operationStatus(_wallet: Address, _opId: string): Promise<never> {
  throw new Error('MAINNET_BANK_OPERATIONS_NOT_READY');
}
