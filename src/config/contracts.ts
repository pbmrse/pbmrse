// Mainnet-only public token configuration.
// PGR/SOV remain unavailable in the UI until mainnet contract verification is accepted.
export const MAINNET_CONTRACTS_READY = false;
export const CONTRACTS = {
  bnb: { usdt: '0x55d398326f99059fF775485246999027B3197955', pgr: '', sov: '' },
} as const;
