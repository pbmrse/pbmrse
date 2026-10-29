import { getAddress, isAddress, type Address } from 'viem';
import { getCloudflareContext } from '@opennextjs/cloudflare';
import { mainnetContracts } from './contracts-mainnet';
import { validSignerCallerSecret } from './signer-service-auth';

function envString(name: string): string | undefined {
  const value = Reflect.get(getCloudflareContext().env, name);
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** Mainnet Swap is isolated from the retired testnet workflow and requires the
 * chain-56 receipt proof plus private Treasury signer payout pipeline. */
export function mainnetSwapEnabled(): boolean {
  if (envString('APP_NETWORK') !== 'bsc-mainnet' ||
      envString('MAINNET_FINANCIAL_MODE') !== 'enabled' ||
      envString('MAINNET_SWAP_ENABLED') !== 'true') return false;
  try {
    const contracts = mainnetContracts();
    const signer = Reflect.get(getCloudflareContext().env, 'TREASURY_SIGNER') as { fetch?: unknown } | undefined;
    const callerSecret = envString('TREASURY_SIGNER_CALLER_SECRET');
    const rpc = envString('BSC_MAINNET_RPC_URL');
    const treasury = envString('MAINNET_SWAP_TREASURY_ADDRESS');
    const paymentRecipient = envString('MAINNET_SWAP_PAYMENT_RECIPIENT');
    return !!signer && typeof signer.fetch === 'function' && validSignerCallerSecret(callerSecret) && !!contracts.pgr && !!contracts.sov &&
      !!rpc && /^https?:\/\//i.test(rpc) &&
      !!treasury && isAddress(treasury) && !/^0x0{40}$/i.test(treasury) &&
      !!paymentRecipient && isAddress(paymentRecipient) && !/^0x0{40}$/i.test(paymentRecipient);
  } catch {
    return false;
  }
}

export function mainnetSwapConfig(): { chainId: 56; pgr: Address; sov: Address; usdt: Address; treasury: Address } {
  if (!mainnetSwapEnabled()) throw new Error('Mainnet swap is disabled or its configuration is incomplete');
  const contracts = mainnetContracts();
  const treasury = envString('MAINNET_SWAP_TREASURY_ADDRESS');
  if (!treasury || !isAddress(treasury) || /^0x0{40}$/i.test(treasury)) throw new Error('Mainnet swap treasury address is missing or invalid');
  return { chainId: 56, pgr: contracts.pgr, sov: contracts.sov, usdt: contracts.usdt, treasury: getAddress(treasury) };
}
