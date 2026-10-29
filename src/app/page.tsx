'use client';

import { Suspense, useEffect, useState } from 'react';
import Link from 'next/link';
import Navbar from '@/components/Navbar';
import { useLanguage } from '@/components/LanguageProvider';
import { BUSINESS, formatPercentBps } from '@/config/business';
import { SOCIAL } from '@/config/social';

type MarketMeta = {
  source: string | null;
  fetchedAt: string | null;
  stale: boolean;
  ageSeconds?: number;
};

type MarketPayload = {
  coins: any[];
  meta: MarketMeta;
  storedAt: number;
};

const MARKET_CACHE_KEY = 'pbm-market-cache-v2';
const LEGACY_MARKET_CACHE_KEY = 'pbm-market-cache-v1';
const MARKET_POLL_MS = 5 * 60 * 1_000;
const MARKET_REQUEST_TIMEOUT_MS = 8_000;
const MARKET_RETRY_BASE_MS = 15_000;
const MARKET_MAX_RETRY_MS = 5 * 60 * 1_000;
const NEWS_POLL_MS = 15 * 60 * 1_000;
const NEWS_MAX_RETRY_MS = 30 * 60 * 1_000;
let marketRequestInFlight: Promise<MarketPayload> | null = null;
let marketFailureCount = 0;
let marketNextAttemptAt = 0;
const newsCache = new Map<string, { items: any[]; storedAt: number }>();
const newsRequests = new Map<string, Promise<any[]>>();
const newsFailures = new Map<string, number>();
const newsNextAttempts = new Map<string, number>();

function scheduleAfterFirstPaint(callback: () => void, delayMs = 50) {
  let timeoutId: number | undefined;
  const frameId = window.requestAnimationFrame(() => {
    timeoutId = window.setTimeout(callback, delayMs);
  });
  return () => {
    window.cancelAnimationFrame(frameId);
    window.clearTimeout(timeoutId);
  };
}

function readMarketCache(): MarketPayload | null {
  try {
    const raw = window.localStorage.getItem(MARKET_CACHE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<MarketPayload>;
      if (Array.isArray(parsed.coins) && parsed.coins.length && parsed.meta && typeof parsed.meta === 'object' && typeof parsed.storedAt === 'number') {
        return {coins: parsed.coins, meta: parsed.meta, storedAt: parsed.storedAt};
      }
    }
    const legacy = window.localStorage.getItem(LEGACY_MARKET_CACHE_KEY);
    if (legacy) {
      const coins = JSON.parse(legacy);
      if (Array.isArray(coins) && coins.length) return {coins, meta: {source: null, fetchedAt: null, stale: true}, storedAt: 0};
    }
  } catch {}
  return null;
}

function requestMarket(): Promise<MarketPayload> {
  if (marketRequestInFlight) return marketRequestInFlight;
  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), MARKET_REQUEST_TIMEOUT_MS);
  marketRequestInFlight = fetch('/api/market', {cache: 'no-store', signal: controller.signal})
    .then(async (response) => {
      const value = await response.json() as {coins?: unknown; meta?: Partial<MarketMeta>};
      if (!response.ok || !Array.isArray(value.coins) || value.coins.length === 0 || !value.meta) throw new Error('MARKET_UNAVAILABLE');
      const payload: MarketPayload = {
        coins: value.coins,
        meta: {
          source: typeof value.meta.source === 'string' ? value.meta.source : null,
          fetchedAt: typeof value.meta.fetchedAt === 'string' ? value.meta.fetchedAt : null,
          stale: value.meta.stale === true,
          ...(typeof value.meta.ageSeconds === 'number' ? {ageSeconds: value.meta.ageSeconds} : {}),
        },
        storedAt: Date.now(),
      };
      marketFailureCount = 0;
      marketNextAttemptAt = payload.storedAt + MARKET_POLL_MS;
      try { window.localStorage.setItem(MARKET_CACHE_KEY, JSON.stringify(payload)); } catch {}
      return payload;
    })
    .catch((error) => {
      marketFailureCount += 1;
      const retryMs = Math.min(MARKET_MAX_RETRY_MS, MARKET_RETRY_BASE_MS * (2 ** Math.min(5, marketFailureCount - 1)));
      marketNextAttemptAt = Date.now() + retryMs;
      throw error;
    })
    .finally(() => {
      window.clearTimeout(timeoutId);
      marketRequestInFlight = null;
    });
  return marketRequestInFlight;
}

function requestNews(language: string): Promise<any[]> {
  const existing = newsRequests.get(language);
  if (existing) return existing;
  const request = fetch(`/api/news?lang=${encodeURIComponent(language)}`)
    .then(async (response) => {
      const value = await response.json() as {items?: unknown};
      if (!response.ok || !Array.isArray(value.items)) throw new Error('NEWS_UNAVAILABLE');
      const items = value.items;
      const storedAt = Date.now();
      newsCache.set(language, {items, storedAt});
      newsFailures.set(language, 0);
      newsNextAttempts.set(language, storedAt + NEWS_POLL_MS);
      return items;
    })
    .catch((error) => {
      const failures = (newsFailures.get(language) ?? 0) + 1;
      newsFailures.set(language, failures);
      newsNextAttempts.set(language, Date.now() + Math.min(NEWS_MAX_RETRY_MS, 60_000 * (2 ** Math.min(5, failures - 1))));
      throw error;
    })
    .finally(() => { newsRequests.delete(language); });
  newsRequests.set(language, request);
  return request;
}

function marketCoinImage(coin: {id?: unknown; image?: unknown}) {
  if (typeof coin.image === 'string' && coin.image.startsWith('https://')) return coin.image;
  const id = typeof coin.id === 'string' ? coin.id.trim().toLowerCase() : '';
  return /^[a-z0-9]+(?:-[a-z0-9]+)+$/.test(id)
    ? `https://static.coinpaprika.com/coin/${encodeURIComponent(id)}/logo.png`
    : '';
}

function SocialIcon({ type }: { type: 'x' | 'github' | 'email' }) {
  if (type === 'x') return <svg viewBox="0 0 24 24" aria-hidden="true" className="h-5 w-5 fill-current"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24h-6.657l-5.214-6.817-5.96 6.817H1.688l7.73-8.835L1.262 2.25h6.826l4.713 6.231 5.443-6.231Zm-1.161 17.52h1.833L7.084 3.875H5.117L17.083 19.77Z" /></svg>;
  if (type === 'github') return <svg viewBox="0 0 24 24" aria-hidden="true" className="h-5 w-5 fill-current"><path d="M12 .5a12 12 0 0 0-3.794 23.385c.6.11.82-.26.82-.577v-2.234c-3.338.726-4.042-1.61-4.042-1.61-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.73.083-.73 1.205.084 1.84 1.237 1.84 1.237 1.07 1.834 2.807 1.304 3.492.997.108-.776.418-1.305.762-1.605-2.665-.304-5.466-1.332-5.466-5.93 0-1.31.468-2.38 1.236-3.22-.124-.303-.536-1.523.117-3.176 0 0 1.008-.322 3.3 1.23a11.48 11.48 0 0 1 6.006 0c2.29-1.552 3.296-1.23 3.296-1.23.655 1.653.243 2.873.12 3.176.77.84 1.234 1.91 1.234 3.22 0 4.61-2.806 5.624-5.478 5.921.43.372.823 1.102.823 2.222v3.293c0 .32.216.694.825.576A12 12 0 0 0 12 .5Z" /></svg>;
  return <svg viewBox="0 0 24 24" aria-hidden="true" className="h-5 w-5 fill-none stroke-current" strokeWidth="1.8"><rect x="3" y="5" width="18" height="14" rx="2" /><path d="m4 7 8 6 8-6" /></svg>;
}

function HomeContent() {
  const { t, language } = useLanguage();
  const [news, setNews] = useState<any[]>([]);
  const [coins, setCoins] = useState<any[]>([]);
  const [marketMeta, setMarketMeta] = useState<MarketMeta | null>(null);
  const [emailOpen, setEmailOpen] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let disposed = false;
    let timer: number | undefined;
    let cancelInitial = () => {};
    const cached = readMarketCache();
    if (cached) {
      setCoins(cached.coins);
      setMarketMeta(cached.meta);
      if (cached.storedAt > 0) marketNextAttemptAt = Math.max(marketNextAttemptAt, cached.storedAt + MARKET_POLL_MS);
    } else if (marketNextAttemptAt > Date.now() + MARKET_RETRY_BASE_MS) {
      // A prior transient failure must not leave a remounted homepage empty for minutes.
      marketNextAttemptAt = Date.now() + MARKET_RETRY_BASE_MS;
    }

    const schedule = () => {
      window.clearTimeout(timer);
      const delay = Math.max(1_000, marketNextAttemptAt - Date.now());
      timer = window.setTimeout(run, delay);
    };
    const run = async () => {
      if (document.visibilityState !== 'visible') return;
      if (Date.now() < marketNextAttemptAt) return schedule();
      try {
        const payload = await requestMarket();
        if (!disposed) {
          setCoins(payload.coins);
          setMarketMeta(payload.meta);
        }
      } catch {
        if (!disposed) setMarketMeta((current) => current ? {...current, stale: true} : current);
      } finally {
        if (!disposed) schedule();
      }
    };
    const onVisibilityChange = () => {
      if (document.visibilityState !== 'visible') {
        window.clearTimeout(timer);
        return;
      }
      void run();
    };
    document.addEventListener('visibilitychange', onVisibilityChange);
    if (!cached || cached.storedAt === 0 || Date.now() >= marketNextAttemptAt) cancelInitial = scheduleAfterFirstPaint(() => { void run(); });
    else schedule();
    return () => {
      disposed = true;
      cancelInitial();
      window.clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, []);

  useEffect(() => {
    let disposed = false;
    let timer: number | undefined;
    let cancelInitial = () => {};
    const cached = newsCache.get(language);
    if (cached) setNews(cached.items);
    const loadNews = async () => {
      if (document.visibilityState !== 'visible') return;
      const nextAttempt = newsNextAttempts.get(language) ?? 0;
      if (Date.now() < nextAttempt) {
        timer = window.setTimeout(() => { void loadNews(); }, Math.max(1_000, nextAttempt - Date.now()));
        return;
      }
      try {
        const items = await requestNews(language);
        if (!disposed) setNews(items);
      } catch {
        // Keep the last valid in-memory response visible and retry with bounded backoff.
      } finally {
        if (!disposed) {
          const nextAttempt = newsNextAttempts.get(language) ?? (Date.now() + NEWS_POLL_MS);
          timer = window.setTimeout(() => { void loadNews(); }, Math.max(1_000, nextAttempt - Date.now()));
        }
      }
    };
    const onVisibilityChange = () => {
      if (document.visibilityState !== 'visible') {
        window.clearTimeout(timer);
        return;
      }
      void loadNews();
    };
    document.addEventListener('visibilitychange', onVisibilityChange);
    cancelInitial = scheduleAfterFirstPaint(() => { void loadNews(); }, 250);
    return () => {
      disposed = true;
      cancelInitial();
      window.clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [language]);

  const copyEmail = async () => {
    await navigator.clipboard?.writeText(SOCIAL.email);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  };

  return (
    <main className="pbm-shell min-h-screen">
      <Navbar deferWallet />
      <div className="lg:ml-[248px]">
        <div className="mx-auto max-w-[1450px] px-4 py-5 sm:px-6 sm:py-7 lg:px-7">

          <section className="pbm-panel pbm-glow pbm-page-enter relative overflow-hidden p-5 sm:p-7 lg:p-9">
            <div className="absolute -right-24 -top-28 h-80 w-80 rounded-full bg-blue-500/10 blur-3xl" />
            <div className="absolute bottom-0 right-[18%] h-32 w-32 rounded-full bg-purple-600/15 blur-2xl" />
            <div className="relative grid items-center gap-8 lg:grid-cols-[1.05fr_.95fr]">
              <div>
                <div className="mb-3 flex items-center gap-2 text-sm font-semibold text-cyan-300"><span className="h-1.5 w-1.5 rounded-full bg-cyan-300 shadow-[0_0_10px_#36d9ff]" />PBMReserves</div>
                <h1 className="max-w-xl text-4xl font-black leading-[1.03] tracking-tight sm:text-5xl lg:text-6xl">{t.heroHeadline}</h1>
                <p className="mt-5 max-w-xl text-sm leading-6 text-slate-400 sm:text-base">{t.heroDescription}</p>
              </div>
              <div className="relative mx-auto flex min-h-[230px] w-full max-w-[470px] items-center justify-center overflow-hidden rounded-2xl border border-blue-400/15 bg-[#020b20]/50 pbm-grid-glow">
                <div className="pbm-ring absolute h-52 w-52 rounded-full" />
                <div className="absolute h-40 w-40 rounded-full border border-purple-400/20 shadow-[0_0_80px_rgba(29,161,255,.2)]" />
                <div className="absolute h-28 w-28 rounded-full border border-cyan-300/20" />
                <img src="/icon.svg" alt="PBMReserves" className="relative z-10 h-28 w-28 drop-shadow-[0_0_30px_rgba(29,161,255,.5)]" />
                <div className="absolute bottom-7 h-1 w-44 rounded-full bg-gradient-to-r from-transparent via-cyan-300 to-transparent opacity-70 blur-[2px]" />
              </div>
            </div>
          </section>

          <section className="mt-5 grid gap-5 xl:grid-cols-[.95fr_1.05fr]">
            <div className="pbm-panel p-5 sm:p-6">
              <div className="flex flex-wrap items-start justify-between gap-3"><div><h2 className="text-lg font-bold">{t.marketTop10}</h2><p className="mt-1 text-xs text-slate-500">{t.marketTop10Desc}</p></div><a href="https://web3.okx.com/join/PBMRESERVES2026" target="_blank" rel="noreferrer" className="rounded-lg border border-cyan-400/25 bg-cyan-400/5 px-3 py-2 text-xs font-semibold text-cyan-200 hover:bg-cyan-400/10">OKX DEX ↗</a></div>
              <div className="mt-4 space-y-2">{coins.length ? coins.map((coin:any,i)=>{const image=marketCoinImage(coin);return <a key={coin.id} href={`https://www.coingecko.com/en/coins/${encodeURIComponent(coin.id)}`} target="_blank" rel="noreferrer" aria-label={`${coin.name} market details`} className="flex items-center gap-3 rounded-xl border border-blue-900/40 bg-blue-950/10 p-3 transition hover:border-cyan-400/40 hover:bg-blue-900/20"><span className="w-5 text-xs text-slate-600">{i+1}</span>{image ? <img src={image} alt="" className="h-7 w-7 rounded-full"/> : <div className="h-7 w-7 rounded-full bg-blue-900/40" />}<div className="min-w-0 flex-1"><div className="font-semibold">{coin.symbol} <span className="ml-1 text-[10px] text-cyan-300">↗</span></div><div className="text-[10px] text-slate-500">{coin.name}</div></div><div className="text-right"><div className="font-mono text-xs">$ {Number(coin.price||0).toLocaleString(language,{maximumFractionDigits:8})}</div><div className={`text-[10px] ${Number(coin.change24h)>=0?'text-emerald-300':'text-rose-300'}`}>{Number(coin.change24h||0).toFixed(2)}%</div></div></a>}) : <p className="p-5 text-sm text-slate-500">{t.loading}</p>}</div>
            </div>
            <div className="pbm-panel p-5 sm:p-6">
              <div className="flex items-center justify-between"><div><h2 className="text-lg font-bold">{t.industryNews}</h2><p className="mt-1 text-xs text-slate-500">{t.industryNewsDesc}</p></div><span className="rounded-full border border-cyan-400/20 bg-cyan-400/5 px-2.5 py-1 text-[10px] text-cyan-300">{t.dailyUpdate}</span></div>
              <div className="mt-4 rounded-xl border border-cyan-400/15 bg-cyan-400/5 p-4"><div className="text-xs uppercase tracking-[.16em] text-cyan-300">{t.announcement}</div><div className="mt-1 text-sm text-slate-200">{t.announcementText}</div></div><div className="mt-4 space-y-2">{news.length ? news.slice(0,6).map((item:any,i)=><a key={i} href={item.link} target="_blank" rel="noreferrer" className="block rounded-xl border border-blue-900/50 bg-blue-950/10 p-4 hover:border-cyan-400/30"><div className="font-semibold text-sm text-white">{item.title}</div><div className="mt-1 text-[11px] text-slate-500">{item.pubDate ? new Date(item.pubDate).toLocaleString(language) : ''}</div></a>) : <p className="p-5 text-sm text-slate-500">{t.loading}</p>}</div>
            </div>
          </section>

          
        </div>

        <div className="mx-auto max-w-[1450px] px-4 pb-5 text-sm text-slate-500 sm:px-6 lg:px-7">{t.networksDesc}</div>

        <footer className="border-t border-blue-950/70 px-4 py-7 sm:px-6 lg:px-7">
          <div className="mx-auto flex max-w-[1450px] flex-col gap-5 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-center gap-3"><img src="/icon.svg" alt="" className="h-8 w-8" /><div><div className="font-semibold">PBMReserves</div></div></div>
            <div className="flex items-center gap-2">
              <a href={SOCIAL.x} target="_blank" rel="noreferrer" aria-label="X" className="grid h-10 w-10 place-items-center rounded-xl border border-blue-900/70 text-slate-400 hover:border-cyan-400/50 hover:text-white"><SocialIcon type="x" /></a>
              <a href={SOCIAL.telegram} target="_blank" rel="noreferrer" aria-label={t.telegram} className="grid h-10 w-10 place-items-center rounded-xl border border-blue-900/70 text-slate-400 hover:border-cyan-400/50 hover:text-white"><SocialIcon type="github" /></a>
              <button type="button" onClick={() => setEmailOpen(true)} aria-label={t.emailSupport} className="grid h-10 w-10 place-items-center rounded-xl border border-blue-900/70 text-slate-400 hover:border-cyan-400/50 hover:text-white"><SocialIcon type="email" /></button>
            </div>
          </div>
          <div className="mx-auto mt-5 max-w-[1450px] border-t border-blue-950/70 pt-4 text-xs text-slate-600">© 2025 PBMReserves. {t.allRights}</div>
        </footer>
      </div>

      {emailOpen && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/75 px-4 backdrop-blur-sm" role="dialog" aria-modal="true" onClick={() => setEmailOpen(false)}>
          <div className="w-full max-w-md rounded-2xl border border-blue-700/50 bg-[#030b1e] p-6 shadow-[0_0_80px_rgba(29,161,255,.15)]" onClick={e => e.stopPropagation()}>
            <div className="flex items-start justify-between gap-4"><div><h2 className="text-xl font-bold">{t.contactTitle}</h2><p className="mt-2 text-sm text-slate-400">{t.chooseEmail}</p></div><button onClick={() => setEmailOpen(false)} className="text-2xl text-slate-500 hover:text-white">×</button></div>
            <div className="mt-5 grid gap-3">
              <a href={'mailto:' + SOCIAL.email + '?subject=' + encodeURIComponent('PBMReserves Support') + '&body=' + encodeURIComponent('Hello PBMReserves Support,\n\n')} className="pbm-btn pbm-btn-primary text-center">{t.defaultEmail}</a>
              <a href={'https://mail.google.com/mail/?view=cm&fs=1&to=' + encodeURIComponent(SOCIAL.email)} target="_blank" rel="noreferrer" className="pbm-btn pbm-btn-secondary text-center">{t.openGmail}</a>
              <a href={'https://outlook.live.com/mail/0/deeplink/compose?to=' + encodeURIComponent(SOCIAL.email)} target="_blank" rel="noreferrer" className="pbm-btn pbm-btn-secondary text-center">{t.openOutlook}</a>
              <button type="button" onClick={copyEmail} className="pbm-btn pbm-btn-secondary">{copied ? t.copied : t.copySupportEmail}</button>
            </div>
            <p className="mt-4 text-xs leading-5 text-slate-500">{t.emailPrivacyNote}</p>
          </div>
        </div>
      )}
    </main>
  );
}

export default function Home() {
  return <Suspense fallback={<div className="min-h-screen bg-[#020617]" />}><HomeContent /></Suspense>;
}
