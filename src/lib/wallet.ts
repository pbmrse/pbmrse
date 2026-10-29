import { WagmiAdapter } from '@reown/appkit-adapter-wagmi';
import { mainnet, bsc, arbitrum, base, optimism, polygon, avalanche, zkSync, linea, scroll, zora, gnosis } from '@reown/appkit/networks';
import { cookieStorage, createStorage } from 'wagmi';

const reownProjectId = process.env.NEXT_PUBLIC_REOWN_PROJECT_ID || 'your_reown_project_id';
export const projectId: string = reownProjectId;

// Public wallet selector for supported production networks.
export const networks = [mainnet, bsc, arbitrum, base, optimism, polygon, avalanche, zkSync, linea, scroll, zora, gnosis];

export const wagmiAdapter = new WagmiAdapter({
  networks,
  projectId,
  ssr: true,
  storage: createStorage({ storage: cookieStorage }),
});

export const config = wagmiAdapter.wagmiConfig;
