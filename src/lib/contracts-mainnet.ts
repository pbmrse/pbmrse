import type { Address } from 'viem';
import { getAddress, isAddress } from 'viem';
import { getCloudflareContext } from '@opennextjs/cloudflare';

export const MAINNET_CHAIN_ID = 56;
export const MAINNET_USDT = getAddress('0x55d398326f99059fF775485246999027B3197955');

function requiredAddress(name: string): Address {
  const value = Reflect.get(getCloudflareContext().env, name);
  if (typeof value !== 'string' || !isAddress(value) || /^0x0{40}$/i.test(value)) {
    throw new Error(`Mainnet contract configuration is missing or invalid: ${name}`);
  }
  return getAddress(value);
}

/**
 * Resolve project token addresses only from encrypted/runtime configuration.
 * PGR and SOV must be deployed and independently verified before these values
 * are configured. Never import testnet deployment addresses as a fallback.
 */
export function mainnetContracts() {
  return {
    usdt: MAINNET_USDT,
    pgr: requiredAddress('MAINNET_PGR_ADDRESS'),
    sov: requiredAddress('MAINNET_SOV_ADDRESS'),
  } as const;
}
