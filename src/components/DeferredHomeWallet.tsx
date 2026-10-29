'use client';

import { lazy, Suspense, useState } from 'react';
import { useLanguage } from '@/components/LanguageProvider';

const WalletIsland = lazy(() => import('@/components/WalletIsland'));

export default function DeferredHomeWallet({ mobileCompact = false }: { mobileCompact?: boolean }) {
  const { t } = useLanguage();
  const [requested, setRequested] = useState(false);

  if (requested) return <Suspense fallback={<span className="block h-10 w-[7.5rem] animate-pulse rounded-xl bg-blue-950/40" aria-hidden="true" />}><WalletIsland mobileCompact={mobileCompact} autoOpen /></Suspense>;
  return (
    <button
      type="button"
      className="btn btn-primary h-10 whitespace-nowrap px-4 py-2.5 text-sm font-bold shadow-lg shadow-violet-950/30 ring-1 ring-violet-400/40 hover:brightness-110 sm:px-5"
      onClick={() => setRequested(true)}
      aria-label={t.connectWalletAction}
    >
      <span className="sm:hidden">◉</span><span className="hidden sm:inline">{t.connectWalletAction}</span>
    </button>
  );
}
