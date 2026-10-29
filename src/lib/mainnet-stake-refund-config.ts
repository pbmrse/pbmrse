import { getCloudflareContext } from '@opennextjs/cloudflare';
import { validSignerCallerSecret } from './signer-service-auth';

const UINT256_MAX = (1n << 256n) - 1n;

function envString(name: string): string | undefined {
  const value = Reflect.get(getCloudflareContext().env, name);
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function positiveAtomic(name: string): bigint | null {
  const value = envString(name);
  if (!value || !/^[1-9][0-9]{0,77}$/.test(value)) return null;
  const amount = BigInt(value);
  return amount <= UINT256_MAX ? amount : null;
}

export function mainnetStakeRefundLimits() {
  const maximumSingleAtomic = positiveAtomic('MAINNET_STAKE_REFUND_MAX_SINGLE_ATOMIC');
  const maximumDailyAtomic = positiveAtomic('MAINNET_STAKE_REFUND_MAX_DAILY_ATOMIC');
  if (!maximumSingleAtomic || !maximumDailyAtomic || maximumSingleAtomic > maximumDailyAtomic) {
    throw new Error('Mainnet stake refund limits are not configured');
  }
  return { maximumSingleAtomic, maximumDailyAtomic };
}

/**
 * Refunds share the existing Treasury signer and its single transaction queue.
 * This gate intentionally validates only public configuration; the private key
 * remains owned and validated by mainnet-bank-config at the moment of signing.
 */
export function mainnetStakeRefundEnabled(): boolean {
  if (envString('APP_NETWORK') !== 'bsc-mainnet' ||
      envString('MAINNET_FINANCIAL_MODE') !== 'enabled' ||
      envString('MAINNET_BANK_ENABLED') !== 'true' ||
      envString('MAINNET_STAKING_LIFECYCLE_READY') !== 'true' ||
      envString('MAINNET_STAKE_REFUND_ENABLED') !== 'true') return false;
  const signer = Reflect.get(getCloudflareContext().env, 'TREASURY_SIGNER') as { fetch?: unknown } | undefined;
  const callerSecret = envString('TREASURY_SIGNER_CALLER_SECRET');
  const rpc = envString('BSC_MAINNET_RPC_URL');
  const expectedAddress = envString('MAINNET_TREASURY_ADDRESS');
  if (!signer || typeof signer.fetch !== 'function' || !validSignerCallerSecret(callerSecret) ||
      !rpc || !expectedAddress || !/^0x[0-9a-fA-F]{40}$/.test(expectedAddress)) return false;
  try { mainnetStakeRefundLimits(); } catch { return false; }
  return true;
}
