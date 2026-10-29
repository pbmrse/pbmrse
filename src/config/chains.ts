export const CHAINS = {
  ethereum: { key: 'ethereum', name: 'Ethereum', type: 'evm', chainId: 1, symbol: 'ETH' },
  bnb: { key: 'bnb', name: 'BNB Chain', type: 'evm', chainId: 56, symbol: 'BNB' },
  arbitrum: { key: 'arbitrum', name: 'Arbitrum', type: 'evm', chainId: 42161, symbol: 'ETH' },
  solana: { key: 'solana', name: 'Solana', type: 'solana', symbol: 'SOL' },
} as const;
