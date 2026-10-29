import { parseAbi } from 'viem';

/** ABI-only utility retained for compile compatibility; legacy payout execution is disabled. */
export const BANK_TOKEN_ABI = parseAbi([
  'function transfer(address to,uint256 amount) returns (bool)',
  'function balanceOf(address) view returns(uint256)',
  'event Transfer(address indexed from,address indexed to,uint256 value)',
]);
export async function processBankJob(_id: string): Promise<never> {
  throw new Error('MAINNET_BANK_PAYOUTS_NOT_READY');
}
