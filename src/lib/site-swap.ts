import type { Address, Hash } from 'viem';
import type { normalizeSwapAction } from './swap-action';

/** Legacy chain-97 swap is retired from the mainnet-only deployment. */
export const SWAP_RECIPIENT = '0x0000000000000000000000000000000000000000' as Address;
export type SwapIntent = {
  intent_id: string; wallet_address: Address; asset: 'PGR' | 'SOV'; amount_atomic: string;
  gross_usdt_atomic: string; fee_usdt_atomic: string; net_usdt_atomic: string; recipient_address: Address;
  created_at: number; status: 'PREPARED' | 'CONFIRMED'; payout_mode: 'LEDGER' | 'WALLET'; tx_hash: Hash | null;
  confirmed_at: number | null;
};
export function swapEnabled(_wallet: Address): boolean { return false; }
export async function applySiteSwap(_wallet: Address, _action: ReturnType<typeof normalizeSwapAction>): Promise<never> {
  throw new Error('MAINNET_SWAP_NOT_READY');
}
