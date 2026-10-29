export type MarketCoin = {
  id: string;
  symbol: string;
  name: string;
  price: number;
  marketCap: number;
  change24h: number;
  image: string;
};

export type MarketSource = 'coingecko' | 'coinpaprika' | 'coinlore';

export type MarketCacheEntry = {
  formatVersion: 1;
  source: MarketSource;
  fetchedAt: string;
  coins: MarketCoin[];
  failureCount?: number;
  nextRetryAt?: string;
};

export type MarketCache = {
  get(): Promise<unknown | null>;
  put(entry: MarketCacheEntry): Promise<void>;
};

type MarketLog = {
  level: 'info' | 'warn';
  event: 'market_upstream' | 'market_cache';
  source: MarketSource | 'last_valid';
  outcome: 'ok' | 'http_error' | 'timeout' | 'network_error' | 'invalid_response' | 'hit' | 'expired' | 'miss';
  elapsedMs?: number;
  status?: number;
  ageSeconds?: number;
};

export type MarketFeedOptions = {
  fetcher?: typeof fetch;
  cache?: MarketCache;
  logger?: (entry: MarketLog) => void;
  now?: () => number;
  timeoutMs?: number;
  freshMs?: number;
  maxStaleMs?: number;
  maxBackoffMs?: number;
};

const DEFAULT_TIMEOUT_MS = 4_000;
export const MARKET_FRESH_MS = 5 * 60 * 1_000;
export const MARKET_MAX_STALE_MS = 15 * 60 * 1_000;
export const MARKET_MAX_BACKOFF_MS = 5 * 60 * 1_000;

const stableIds = new Set(['tether', 'usd-coin', 'dai', 'first-digital-usd', 'usds', 'usde', 'usdd', 'true-usd']);
const stableSymbols = new Set(['USDT', 'USDC', 'DAI', 'FDUSD', 'USDS', 'USDE', 'USDD', 'TUSD']);

const sources: Array<{
  name: MarketSource;
  url: string;
  parse: (value: unknown) => MarketCoin[];
}> = [
  {
    name: 'coingecko',
    url: 'https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=50&page=1&sparkline=false&price_change_percentage=24h',
    parse(value) {
      if (!Array.isArray(value)) return [];
      return value
        .filter((item) => isRecord(item) && !stableIds.has(String(item.id).toLowerCase()))
        .map((item) => ({
          id: String(item.id ?? ''),
          symbol: String(item.symbol ?? '').toUpperCase(),
          name: String(item.name ?? ''),
          price: Number(item.current_price),
          marketCap: Number(item.market_cap),
          change24h: Number(item.price_change_percentage_24h),
          image: String(item.image ?? ''),
        }));
    },
  },
  {
    name: 'coinpaprika',
    url: 'https://api.coinpaprika.com/v1/tickers?quotes=USD&limit=50',
    parse(value) {
      if (!Array.isArray(value)) return [];
      return value
        .filter((item) => isRecord(item) && !stableSymbols.has(String(item.symbol).toUpperCase()))
        .map((item) => {
          const quote = isRecord(item.quotes) && isRecord(item.quotes.USD) ? item.quotes.USD : {};
          return {
            id: String(item.id ?? ''),
            symbol: String(item.symbol ?? '').toUpperCase(),
            name: String(item.name ?? ''),
            price: Number(quote.price),
            marketCap: Number(quote.market_cap),
            change24h: Number(quote.percent_change_24h),
            image: `https://static.coinpaprika.com/coin/${encodeURIComponent(String(item.id ?? ''))}/logo.png`,
          };
        });
    },
  },
  {
    name: 'coinlore',
    url: 'https://api.coinlore.net/api/tickers/?start=0&limit=50',
    parse(value) {
      if (!isRecord(value) || !Array.isArray(value.data)) return [];
      return value.data
        .filter((item) => isRecord(item) && !stableSymbols.has(String(item.symbol).toUpperCase()))
        .map((item) => {
          const nameId = String(item.nameid ?? '').trim().toLowerCase();
          return {
            id: nameId,
            symbol: String(item.symbol ?? '').toUpperCase(),
            name: String(item.name ?? ''),
            price: Number(item.price_usd),
            marketCap: Number(item.market_cap_usd),
            change24h: Number(item.percent_change_24h),
            image: /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(nameId)
              ? `https://c1.coinlore.com/img/25x25/${encodeURIComponent(nameId)}.png`
              : '',
          };
        });
    },
  },
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isValidCoin(value: unknown): value is MarketCoin {
  if (!isRecord(value)) return false;
  return typeof value.id === 'string' && value.id.length > 0
    && typeof value.symbol === 'string' && value.symbol.length > 0
    && typeof value.name === 'string' && value.name.length > 0
    && typeof value.price === 'number' && Number.isFinite(value.price) && value.price > 0
    && typeof value.marketCap === 'number' && Number.isFinite(value.marketCap) && value.marketCap >= 0
    && typeof value.change24h === 'number' && Number.isFinite(value.change24h)
    && typeof value.image === 'string'
    && (value.image === '' || value.image.startsWith('https://'));
}

function validateCoins(values: MarketCoin[]): MarketCoin[] | null {
  const unique = new Set<string>();
  const valid = values.filter((coin) => {
    if (!isValidCoin(coin) || stableSymbols.has(coin.symbol) || unique.has(coin.id)) return false;
    unique.add(coin.id);
    return true;
  }).slice(0, 10);
  return valid.length > 0 ? valid : null;
}

function validateCache(value: unknown): MarketCacheEntry | null {
  if (!isRecord(value) || value.formatVersion !== 1 || !sources.some((source) => source.name === value.source)) return null;
  if (typeof value.fetchedAt !== 'string' || !Number.isFinite(Date.parse(value.fetchedAt))) return null;
  if (!Array.isArray(value.coins) || !value.coins.every(isValidCoin)) return null;
  if (value.failureCount !== undefined && (typeof value.failureCount !== 'number' || !Number.isInteger(value.failureCount) || value.failureCount < 0)) return null;
  if (value.nextRetryAt !== undefined && (typeof value.nextRetryAt !== 'string' || !Number.isFinite(Date.parse(value.nextRetryAt)))) return null;
  const coins = validateCoins(value.coins);
  if (!coins) return null;
  return {
    formatVersion: 1,
    source: value.source as MarketSource,
    fetchedAt: value.fetchedAt,
    coins,
    ...(value.failureCount === undefined ? {} : {failureCount: value.failureCount}),
    ...(value.nextRetryAt === undefined ? {} : {nextRetryAt: value.nextRetryAt}),
  };
}

async function fetchJson(fetcher: typeof fetch, url: string, timeoutMs: number): Promise<{response: Response; payload?: unknown; invalid: boolean}> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetcher(url, {
      headers: {accept: 'application/json', 'user-agent': 'PBMReserves/1.0'},
      cache: 'no-store',
      signal: controller.signal,
    });
    if (!response.ok) return {response, invalid: false};
    try {
      return {response, payload: await response.json(), invalid: false};
    } catch (error) {
      if (controller.signal.aborted) throw error;
      return {response, invalid: true};
    }
  } finally {
    clearTimeout(timeout);
  }
}

function errorOutcome(error: unknown): MarketLog['outcome'] {
  return isRecord(error) && error.name === 'AbortError' ? 'timeout' : 'network_error';
}

export async function getMarketResponse(options: MarketFeedOptions = {}): Promise<Response> {
  const fetcher = options.fetcher ?? fetch;
  const now = options.now ?? Date.now;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const freshMs = options.freshMs ?? MARKET_FRESH_MS;
  const maxStaleMs = options.maxStaleMs ?? MARKET_MAX_STALE_MS;
  const maxBackoffMs = options.maxBackoffMs ?? MARKET_MAX_BACKOFF_MS;
  const log = options.logger ?? ((entry: MarketLog) => console[entry.level](JSON.stringify(entry)));
  const cached = validateCache(await options.cache?.get().catch(() => null));
  const cachedAgeMs = cached ? now() - Date.parse(cached.fetchedAt) : null;

  if (cached && cachedAgeMs !== null && cachedAgeMs >= 0 && cachedAgeMs < freshMs) {
    const ageSeconds = Math.floor(cachedAgeMs / 1_000);
    log({level: 'info', event: 'market_cache', source: 'last_valid', outcome: 'hit', ageSeconds});
    return Response.json({coins: cached.coins, meta: {source: cached.source, fetchedAt: cached.fetchedAt, stale: false, ageSeconds}}, {
      headers: {'cache-control': 'public, max-age=60, s-maxage=300, must-revalidate', 'x-market-cache': 'HIT'},
    });
  }

  const nextRetryAt = cached?.nextRetryAt ? Date.parse(cached.nextRetryAt) : Number.NaN;
  if (cached && cachedAgeMs !== null && cachedAgeMs >= 0 && cachedAgeMs <= maxStaleMs && Number.isFinite(nextRetryAt) && now() < nextRetryAt) {
    const ageSeconds = Math.floor(cachedAgeMs / 1_000);
    log({level: 'warn', event: 'market_cache', source: 'last_valid', outcome: 'hit', ageSeconds});
    return Response.json({coins: cached.coins, meta: {source: cached.source, fetchedAt: cached.fetchedAt, stale: true, ageSeconds}}, {
      headers: {'cache-control': 'public, max-age=15, s-maxage=15, must-revalidate', 'x-market-cache': 'STALE-BACKOFF'},
    });
  }

  for (const source of sources) {
    const startedAt = now();
    try {
      const {response, payload, invalid} = await fetchJson(fetcher, source.url, timeoutMs);
      const elapsedMs = Math.max(0, now() - startedAt);
      if (!response.ok) {
        log({level: 'warn', event: 'market_upstream', source: source.name, outcome: 'http_error', status: response.status, elapsedMs});
        continue;
      }
      if (invalid) {
        log({level: 'warn', event: 'market_upstream', source: source.name, outcome: 'invalid_response', status: response.status, elapsedMs});
        continue;
      }
      const coins = validateCoins(source.parse(payload));
      if (!coins) {
        log({level: 'warn', event: 'market_upstream', source: source.name, outcome: 'invalid_response', status: response.status, elapsedMs});
        continue;
      }
      const entry: MarketCacheEntry = {formatVersion: 1, source: source.name, fetchedAt: new Date(now()).toISOString(), coins};
      await options.cache?.put(entry).catch(() => undefined);
      log({level: 'info', event: 'market_upstream', source: source.name, outcome: 'ok', status: response.status, elapsedMs});
      return Response.json({coins, meta: {source: source.name, fetchedAt: entry.fetchedAt, stale: false}}, {
        headers: {'cache-control': 'public, max-age=60, s-maxage=60, must-revalidate'},
      });
    } catch (error) {
      log({level: 'warn', event: 'market_upstream', source: source.name, outcome: errorOutcome(error), elapsedMs: Math.max(0, now() - startedAt)});
    }
  }

  if (cached) {
    const ageMs = cachedAgeMs ?? now() - Date.parse(cached.fetchedAt);
    if (ageMs >= 0 && ageMs <= maxStaleMs) {
      const ageSeconds = Math.floor(ageMs / 1_000);
      const failureCount = Math.min(30, (cached.failureCount ?? 0) + 1);
      const backoffMs = Math.min(maxBackoffMs, 60_000 * (2 ** Math.min(10, failureCount - 1)));
      await options.cache?.put({...cached, failureCount, nextRetryAt: new Date(now() + backoffMs).toISOString()}).catch(() => undefined);
      log({level: 'warn', event: 'market_cache', source: 'last_valid', outcome: 'hit', ageSeconds});
      return Response.json({coins: cached.coins, meta: {source: cached.source, fetchedAt: cached.fetchedAt, stale: true, ageSeconds}}, {
        headers: {'cache-control': 'public, max-age=15, s-maxage=15, must-revalidate', 'x-market-cache': 'STALE'},
      });
    }
    log({level: 'warn', event: 'market_cache', source: 'last_valid', outcome: 'expired', ageSeconds: Math.max(0, Math.floor(ageMs / 1_000))});
  } else {
    log({level: 'warn', event: 'market_cache', source: 'last_valid', outcome: 'miss'});
  }
  return Response.json({coins: [], meta: {source: null, fetchedAt: null, stale: true}}, {
    status: 502,
    headers: {'cache-control': 'no-store'},
  });
}
