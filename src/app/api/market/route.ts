import {getMarketResponse, MARKET_MAX_STALE_MS, type MarketCache, type MarketCacheEntry} from '@/lib/market-feed';

const CACHE_NAME = 'pbmrse-market-v2';
const CACHE_KEY = 'https://pbmreserves.xyz/__pbm-cache/market/v2';

type MarketResponseSnapshot = {
  body: string;
  headers: Array<[string, string]>;
  status: number;
};

// The shared result is fully buffered public JSON, never a Request, Response,
// stream, binding, authentication value, wallet value, or other I/O object.
// The Cache API remains the cross-isolate source of truth.
let marketRefreshInFlight: Promise<MarketResponseSnapshot> | undefined;

async function marketSnapshot(cache: MarketCache | undefined): Promise<MarketResponseSnapshot> {
  const response = await getMarketResponse({cache});
  return {body: await response.text(), headers: [...response.headers], status: response.status};
}

async function workerCache(request: Request): Promise<MarketCache | undefined> {
  if (typeof caches === 'undefined') return undefined;
  const cache = await caches.open(CACHE_NAME);
  const legacyCache = await caches.open('pbmrse-market-v1');
  const legacyKey = new URL('/__pbm-cache/market/v1', request.url).toString();
  return {
    async get() {
      const response = await cache.match(CACHE_KEY) ?? await legacyCache.match(legacyKey);
      if (!response) return null;
      try {
        return await response.json();
      } catch {
        return null;
      }
    },
    async put(entry: MarketCacheEntry) {
      await cache.put(CACHE_KEY, Response.json(entry, {
        headers: {'cache-control': `public, max-age=${Math.floor(MARKET_MAX_STALE_MS / 1_000)}`},
      }));
    },
  };
}

export async function GET(request: Request) {
  const cache = await workerCache(request).catch(() => undefined);
  const running = marketRefreshInFlight ?? marketSnapshot(cache);
  marketRefreshInFlight = running;
  try {
    const result = await running;
    return new Response(result.body, {headers: result.headers, status: result.status});
  } finally {
    if (marketRefreshInFlight === running) marketRefreshInFlight = undefined;
  }
}
