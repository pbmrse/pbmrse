'use client';

import { useEffect, useRef } from 'react';
import { useAccount } from 'wagmi';
import Providers, { appKit } from '@/app/providers';
import ConnectWallet from '@/components/ConnectWallet';

function WalletControl({ mobileCompact, autoOpen }: { mobileCompact: boolean; autoOpen: boolean }) {
  const { isConnected, status } = useAccount();
  const attempted = useRef(false);
  const automaticConnectViewOpen = useRef(false);

  useEffect(() => {
    if (!autoOpen || attempted.current || isConnected || status !== 'disconnected') return;

    // Let wagmi restore a persisted mobile-wallet session before showing the
    // selector. Without this grace period AppKit can open while reconnecting,
    // leaving an already-connected OKX wallet behind the Connect modal.
    const timer = window.setTimeout(() => {
      attempted.current = true;
      automaticConnectViewOpen.current = true;
      void appKit.open({ view: 'Connect' });
    }, 350);

    return () => window.clearTimeout(timer);
  }, [autoOpen, isConnected, status]);

  useEffect(() => {
    if (!isConnected || !automaticConnectViewOpen.current) return;
    automaticConnectViewOpen.current = false;
    void appKit.close();
  }, [isConnected]);

  return <ConnectWallet mobileCompact={mobileCompact} autoPrompt={false} />;
}

export default function WalletIsland({ mobileCompact = false, autoOpen = false }: { mobileCompact?: boolean; autoOpen?: boolean }) {
  return <Providers><WalletControl mobileCompact={mobileCompact} autoOpen={autoOpen} /></Providers>;
}
