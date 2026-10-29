'use client';

import { getAddress, isAddress, parseAbi, type Address } from 'viem';

// Client-safe, mainnet-only token configuration. Never fall back to testnet addresses.
// PGR/SOV addresses must match the deployed and verified BSC mainnet contracts.
export const MAINNET_CHAIN_ID = 56;
export const MAINNET_USDT = getAddress('0x55d398326f99059fF775485246999027B3197955');
const ZERO = '0x0000000000000000000000000000000000000000' as Address;
function publicTokenAddress(value: string | undefined): Address {
  return value && isAddress(value) && value.toLowerCase() !== ZERO.toLowerCase()
    ? getAddress(value)
    : ZERO;
}
export const MAINNET_MINING_PAYMENT_RECIPIENT = publicTokenAddress(process.env.NEXT_PUBLIC_MAINNET_MINING_PAYMENT_RECIPIENT);
export const MAINNET_SWAP_PAYMENT_RECIPIENT = publicTokenAddress(process.env.NEXT_PUBLIC_MAINNET_SWAP_PAYMENT_RECIPIENT);
export const MAINNET_CONTRACTS = {
  usdt: MAINNET_USDT,
  pgr: publicTokenAddress(process.env.NEXT_PUBLIC_MAINNET_PGR_ADDRESS ?? '0x61250E93E71F353DCc0B10A8C79A6A4f918283b6'),
  sov: publicTokenAddress(process.env.NEXT_PUBLIC_MAINNET_SOV_ADDRESS ?? '0xf2Eb81A5cAF0e99dc7c278e62407468be9d07224'),
} as const;
export const ERC20_ABI = parseAbi([
  'function balanceOf(address account) view returns (uint256)',
  'function transfer(address to, uint256 value) returns (bool)',
  'function approve(address spender, uint256 value) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'event Transfer(address indexed from, address indexed to, uint256 value)',
]);
