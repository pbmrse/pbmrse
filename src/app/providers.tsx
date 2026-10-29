'use client';

import { createAppKit } from '@reown/appkit/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { WagmiProvider } from 'wagmi';
import { useState } from 'react';
import { config, networks, projectId, wagmiAdapter } from '@/lib/wallet';

const metadata = {
  name: 'PBMReserves',
  description: 'PBMReserves Web3 DApp',
  url: 'https://app.pbmreserves.xyz',
  icons: ['https://app.pbmreserves.xyz/icon-512.png'],
};

export const appKit = createAppKit({
  adapters: [wagmiAdapter],
  networks: networks as any,
  projectId: projectId as string,
  metadata,
  defaultNetwork: (networks.find(n=>n.id===56) ?? networks[0]) as any,
  themeMode: 'dark',
  allWallets: 'SHOW',
  features: {
    analytics: true,
    email: false,
    socials: false,
  },
});

export default function Providers({ children }: { children: React.ReactNode }) {
  const [queryClient] = useState(() => new QueryClient());

  return (
    <WagmiProvider config={config}>
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    </WagmiProvider>
  );
}
