'use client';

import Link from 'next/link';
import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { usePathname } from 'next/navigation';
import { LANGUAGES, type LanguageKey } from '@/config/i18n';
import { useLanguage } from '@/components/LanguageProvider';
import DeferredHomeWallet from '@/components/DeferredHomeWallet';

const ConnectWallet = lazy(() => import('@/components/ConnectWallet'));
const walletFallback = <span className="block h-10 w-[7.5rem] animate-pulse rounded-xl bg-blue-950/40" aria-hidden="true" />;

const navItems = [
  { key: 'dashboard', href: '/', icon: '⌂' },
  { key: 'stake', href: '/stake', icon: '◈' },
  { key: 'mining', href: '/mining', icon: '✦' },
  { key: 'swap', href: '/swap', icon: '⇄' },
  { key: 'records', href: '/records', icon: '◎' },
] as const;

function Brand({ tagline }: { tagline: string }) {
  return (
    <Link href="/" className="flex min-w-0 items-center gap-2 sm:gap-3" aria-label="PBMReserves home">
      <img src="/icon.svg" alt="" className="h-9 w-9 shrink-0 sm:h-10 sm:w-10 drop-shadow-[0_0_18px_rgba(29,161,255,.35)]" />
      <div className="min-w-0">
        <div className="truncate text-base font-extrabold tracking-tight text-white sm:text-lg">PBM<span className="pbm-gradient-text">Reserves</span></div>
        <div className="truncate text-[8px] uppercase tracking-[.16em] text-slate-500 sm:text-[9px] sm:tracking-[.22em]">{tagline}</div>
      </div>
    </Link>
  );
}

export default function Navbar({ deferWallet = false }: { deferWallet?: boolean }) {
  const { language, setLanguage, t } = useLanguage();
  const pathname = usePathname();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [languageOpen, setLanguageOpen] = useState(false);
  const languageRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (event: MouseEvent) => {
      if (languageRef.current && !languageRef.current.contains(event.target as Node)) setLanguageOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  function changeLanguage(next: LanguageKey) {
    setLanguage(next);
    setLanguageOpen(false);
    setMobileOpen(false);
    document.documentElement.lang = next;
  }

  return (
    <>
      <aside className="fixed inset-y-0 left-0 z-40 hidden w-[248px] border-r border-blue-950/70 bg-[#020a1c]/95 px-5 py-6 backdrop-blur-xl lg:flex lg:flex-col">
        <Brand tagline={t.brandTagline} />
        <nav className="mt-9 space-y-2">
          {navItems.map(item => {
            const active = pathname === item.href;
            return (
              <Link key={item.href} href={item.href} prefetch={deferWallet ? false : null} className={`group flex items-center gap-3 rounded-xl px-4 py-3 text-sm transition ${active ? 'bg-gradient-to-r from-blue-600/90 to-indigo-600/70 text-white shadow-[0_0_25px_rgba(29,161,255,.18)]' : 'text-slate-400 hover:bg-blue-950/50 hover:text-white'}`}>
                <span className="grid h-8 w-8 place-items-center rounded-lg bg-white/5 text-lg">{item.icon}</span>
                <span>{t[item.key]}</span>
                {active && <span className="ml-auto h-1.5 w-1.5 rounded-full bg-cyan-300 shadow-[0_0_9px_#36d9ff]" />}
              </Link>
            );
          })}
        </nav>
        <div className="mt-auto rounded-2xl border border-blue-900/70 bg-[radial-gradient(circle_at_20%_20%,rgba(29,161,255,.2),transparent_40%),#04132e] p-4">
          <div className="flex items-center gap-3">
            <img src="/icon.svg" alt="" className="h-9 w-9" />
            <div><div className="text-sm font-bold">PBMReserves</div><div className="text-[10px] text-slate-500">{t.brandFooterTagline}</div></div>
          </div>
        </div>
      </aside>

      <header className="sticky top-0 z-30 border-b border-blue-950/70 bg-[#020817]/88 backdrop-blur-xl lg:ml-[248px]">
        <div className="flex min-h-[72px] items-center gap-3 px-4 sm:px-6 lg:px-7">
          <div className="min-w-0 flex-1 overflow-hidden lg:hidden"><Brand tagline={t.brandTagline} /></div>
          <div className="ml-auto flex shrink-0 items-center gap-1.5 sm:gap-2">
            <div ref={languageRef} className="relative hidden sm:block">
              <button type="button" onClick={() => setLanguageOpen(v => !v)} className="rounded-xl border border-blue-900/70 bg-blue-950/30 px-3 py-2 text-xs text-slate-300 hover:bg-blue-900/40">
                🌐 {LANGUAGES.find(item => item.key === language)?.label}
              </button>
              {languageOpen && (
                <div className="absolute right-0 top-full z-50 mt-2 w-44 overflow-hidden rounded-xl border border-blue-900 bg-[#030b1e] shadow-2xl">
                  {LANGUAGES.map(item => <button key={item.key} type="button" onClick={() => changeLanguage(item.key)} className="w-full px-4 py-3 text-left text-sm text-slate-300 hover:bg-blue-950/60">{item.label}{item.key === language && <span className="float-right">✓</span>}</button>)}
                </div>
              )}
            </div>
            <div className="hidden sm:block">{deferWallet ? <DeferredHomeWallet /> : <Suspense fallback={walletFallback}><ConnectWallet /></Suspense>}</div>
            <div className="sm:hidden">{deferWallet ? <DeferredHomeWallet mobileCompact /> : <Suspense fallback={walletFallback}><ConnectWallet mobileCompact /></Suspense>}</div>
            <button type="button" onClick={() => setMobileOpen(v => !v)} className="rounded-xl border border-blue-900/70 bg-blue-950/30 px-3 py-2 text-lg text-slate-300 lg:hidden" aria-label={mobileOpen ? t.closeMenu : t.mobileMenu}>{mobileOpen ? '×' : '☰'}</button>
          </div>
        </div>
        {mobileOpen && (
          <div className="border-t border-blue-950/70 bg-[#020817] p-3 lg:hidden">
            <nav className="grid grid-cols-2 gap-2">
              {navItems.map(item => {
                const active = pathname === item.href;
                return <Link key={item.href} href={item.href} prefetch={deferWallet ? false : null} onClick={() => setMobileOpen(false)} className={`flex items-center gap-2 rounded-xl px-3 py-3 text-sm ${active ? 'bg-blue-600/80 text-white' : 'bg-blue-950/30 text-slate-300'}`}><span>{item.icon}</span>{t[item.key]}</Link>;
              })}
            </nav>
            <div ref={languageRef} className="mt-3">
              <button type="button" onClick={() => setLanguageOpen(v => !v)} className="flex w-full items-center justify-between rounded-xl border border-blue-900/70 px-3 py-3 text-sm text-slate-300"><span>🌐 {LANGUAGES.find(item => item.key === language)?.label}</span><span>⌄</span></button>
              {languageOpen && <div className="mt-2 overflow-hidden rounded-xl border border-blue-900 bg-[#030b1e]">{LANGUAGES.map(item => <button key={item.key} type="button" onClick={() => changeLanguage(item.key)} className="w-full px-4 py-3 text-left text-sm text-slate-300 hover:bg-blue-950/60">{item.label}{item.key === language && <span className="float-right">✓</span>}</button>)}</div>}
            </div>
          </div>
        )}
      </header>

      <nav className="fixed inset-x-0 bottom-0 z-40 grid grid-cols-5 border-t border-blue-950/80 bg-[#020817]/95 px-2 py-2 backdrop-blur-xl lg:hidden">
        {[navItems[0], navItems[1], navItems[2], navItems[3], navItems[4]].map(item => {
          const active = pathname === item.href;
          return <Link key={item.href} href={item.href} prefetch={deferWallet ? false : null} className={`flex flex-col items-center gap-0.5 rounded-lg py-1 text-[10px] ${active ? 'text-cyan-300' : 'text-slate-500'}`}><span className="text-lg">{item.icon}</span><span>{t[item.key]}</span></Link>;
        })}
      </nav>
    </>
  );
}
