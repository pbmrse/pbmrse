'use client';

import { useEffect, useRef, useState } from 'react';
import { useAppKit, useAppKitNetwork } from '@reown/appkit/react';
import { NetworkIcon } from '@web3icons/react/dynamic';
import { useAccount, useChainId, useDisconnect } from 'wagmi';
import { useLanguage } from '@/components/LanguageProvider';
import { appKit } from '@/app/providers';

const chainInfo: Record<number, { name: string; symbol: string }> = {
  1: { name: 'Ethereum', symbol: 'ETH' },
  56: { name: 'BNB Chain', symbol: 'BNB' },
  42161: { name: 'Arbitrum', symbol: 'ARB' },
  8453: { name: 'Base', symbol: 'BASE' },
  10: { name: 'Optimism', symbol: 'OP' },
  137: { name: 'Polygon', symbol: 'POL' },
  43114: { name: 'Avalanche', symbol: 'AVAX' },
  324: { name: 'zkSync', symbol: 'ZK' },
  59144: { name: 'Linea', symbol: 'LINEA' },
  534352: { name: 'Scroll', symbol: 'SCR' },
  7777777: { name: 'Zora', symbol: 'ZORA' },
  100: { name: 'Gnosis', symbol: 'GNO' },
};

function normalizeNetworkId(value: number | string | undefined) {
  if (value == null) return undefined;
  const text = String(value);
  return text.includes(':') ? text.split(':').pop() : text;
}

export default function ConnectWallet({ mobileMenu = false, mobileCompact = false, autoPrompt = true }: { mobileMenu?: boolean; mobileCompact?: boolean; autoPrompt?: boolean }) {
  const { t } = useLanguage();
  const { open, close } = useAppKit();
  const { chainId: appKitChainId } = useAppKitNetwork();
  const { address, isConnected, status } = useAccount();
  const { disconnect } = useDisconnect();
  const chainId = useChainId();
  const [openMenu, setOpenMenu] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const networkViewOpen = useRef(false);
  const networkViewChainId = useRef<number | string | undefined>(undefined);
  const automaticConnectViewOpen = useRef(false);

  useEffect(() => {
    const unsubscribe = appKit.subscribeCaipNetworkChange((newNetwork) => {
      if (!networkViewOpen.current) return;

      const nextNetworkId = normalizeNetworkId(newNetwork?.id);
      const openedNetworkId = normalizeNetworkId(networkViewChainId.current);

      if (nextNetworkId && openedNetworkId && nextNetworkId !== openedNetworkId) {
        networkViewOpen.current = false;
        networkViewChainId.current = undefined;
        void close();
      }
    });

    return () => unsubscribe?.();
  }, [close]);

  useEffect(() => {
    if (!networkViewOpen.current) return;

    const currentNetworkId = normalizeNetworkId(appKitChainId ?? chainId);
    const openedNetworkId = normalizeNetworkId(networkViewChainId.current);

    if (currentNetworkId && openedNetworkId && currentNetworkId !== openedNetworkId) {
      networkViewOpen.current = false;
      networkViewChainId.current = undefined;
      void close();
    }
  }, [appKitChainId, chainId, close]);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpenMenu(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  useEffect(() => {
    if (!autoPrompt || typeof window === 'undefined' || isConnected || status !== 'disconnected') return;
    const key = 'pbm_wallet_prompt_v3';
    try {
      if (sessionStorage.getItem(key)) return;
    } catch {
      return;
    }
    const timer = window.setTimeout(() => {
      try { sessionStorage.setItem(key, '1'); } catch { return; }
      automaticConnectViewOpen.current = true;
      void open({ view: 'Connect' });
    }, 1200);
    return () => window.clearTimeout(timer);
  }, [autoPrompt, isConnected, open, status]);

  useEffect(() => {
    if (!isConnected || !automaticConnectViewOpen.current) return;
    automaticConnectViewOpen.current = false;
    void close();
  }, [close, isConnected]);

  const short = address ? address.slice(0, 6) + '...' + address.slice(-4) : '';
  const displayChainId = isConnected && chainInfo[chainId] ? chainId : 56;
  const displayChain = chainInfo[displayChainId];

  return (
    <div className='flex items-center gap-1.5 sm:gap-2' ref={ref}>
      <button
        type='button'
        aria-label={t.supportedChains}
        title={displayChain.name}
        className='flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-slate-700 bg-slate-900/80 hover:border-slate-500'
        onClick={() => {
          networkViewChainId.current = appKitChainId ?? chainId;
          networkViewOpen.current = true;
          void open({ view: 'Networks' });
        }}
      >
        <NetworkIcon chainId={displayChainId} size={28} variant='branded' />
      </button>
      {isConnected && address ? (
        <div className='relative'>
          <button
            type='button'
            className='btn btn-secondary flex h-10 items-center gap-1.5 px-2.5 sm:gap-2 sm:px-3.5'
            onClick={() => setOpenMenu(v => !v)}
            aria-label={t.connectedWallet}
          >
            <span className='font-mono text-xs'>{short}</span>
            <span className='text-xs opacity-60'>{openMenu ? '▲' : '▼'}</span>
          </button>

          {openMenu && (
            <div className='absolute right-0 z-50 mt-3 w-[min(20rem,calc(100vw-1rem))] overflow-hidden rounded-2xl border border-slate-700 bg-slate-950 shadow-2xl'>
              <div className='border-b border-slate-800 px-4 py-4'>
                <div className='text-xs text-slate-500'>{t.connectedWallet}</div>
                <button type='button' onClick={async () => { try { await navigator.clipboard.writeText(address); } catch {} }} className='mt-2 block w-full text-left'>
                  <div className='break-all font-mono text-sm text-white'>{address}</div>
                  <div className='mt-1 text-xs text-slate-500'>{t.copyAddress}</div>
                </button>
              </div>
              <div className='p-2'>
                <div className='rounded-xl bg-slate-900 px-3 py-3'>
                  <div className='text-xs text-slate-500'>{t.currentNetwork}</div>
                  <div className='mt-1 flex items-center gap-2 text-sm text-slate-200'>
                    <NetworkIcon chainId={displayChainId} size={24} variant='branded' />
                    <span>{displayChain.name}</span>
                  </div>
                </div>
              </div>
              <div className='border-t border-slate-800 p-2'>
                <button type='button' className='w-full rounded-xl px-3 py-3 text-left text-sm text-slate-300 hover:bg-slate-800' onClick={() => { setOpenMenu(false); disconnect(); }}>
                  {t.disconnect}
                </button>
              </div>
            </div>
          )}
        </div>
      ) : (
        <button type='button' className='btn btn-primary h-10 whitespace-nowrap px-4 py-2.5 text-sm font-bold shadow-lg shadow-violet-950/30 ring-1 ring-violet-400/40 hover:brightness-110 sm:px-5' onClick={() => open({ view: 'Connect' })}>
          <span className='sm:hidden'>◉</span><span className='hidden sm:inline'>{t.connectWalletAction}</span>
        </button>
      )}
    </div>
  );
}
