import { getCloudflareContext } from '@opennextjs/cloudflare';

// Structural subset of the D1 binding used by this application.
export type Statement = {
  bind(...values: (string | number | null)[]): Statement;
  first<T>(): Promise<T | null>;
  all<T>(): Promise<{ results: T[] }>;
  run(): Promise<unknown>;
};
export type Database = {
  prepare(sql: string): Statement;
  batch(statements: Statement[]): Promise<{ results: Record<string, unknown>[]; meta: { changes: number } }[]>;
};
export function serverDB(): Database {
  const env = getCloudflareContext().env;
  const mainnet = Reflect.get(env, 'APP_NETWORK') === 'bsc-mainnet';
  // Never fall back to the legacy/testnet database when running the mainnet Worker.
  const binding = mainnet ? 'ADDRESS_DB_MAINNET' : 'ADDRESS_DB';
  const db = Reflect.get(env, binding) as Database | undefined;
  if (!db) throw new Error(`Database binding is not configured: ${binding}`);
  return db;
}
