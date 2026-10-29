import type { Database } from './server-db';

type GateEnv = Record<string, unknown>;

function envString(env: GateEnv, name: string): string | null {
  const value = Reflect.get(env, name);
  return typeof value === 'string' ? value : null;
}

function positiveAtomic(value: string | null): boolean {
  if (!value || !/^[1-9][0-9]{0,77}$/.test(value)) return false;
  return BigInt(value) <= (1n << 256n) - 1n;
}

/**
 * Cheap pre-signature gate. This does not authorize a cancellation; the POST
 * route and refund engine repeat all authoritative checks after wallet auth.
 */
export async function mainnetStakeCancellationReadiness(db: Database, env: GateEnv) {
  if (envString(env, 'APP_NETWORK') !== 'bsc-mainnet') return { ready:false, code:'MAINNET_NETWORK_REQUIRED' } as const;
  if (envString(env, 'MAINNET_FINANCIAL_MODE') !== 'enabled' ||
      envString(env, 'MAINNET_BANK_ENABLED') !== 'true' ||
      envString(env, 'MAINNET_STAKING_LIFECYCLE_READY') !== 'true' ||
      envString(env, 'MAINNET_STAKE_REFUND_ENABLED') !== 'true') {
    return { ready:false, code:'MAINNET_STAKE_CANCELLATION_NOT_READY' } as const;
  }
  const single = envString(env, 'MAINNET_STAKE_REFUND_MAX_SINGLE_ATOMIC');
  const daily = envString(env, 'MAINNET_STAKE_REFUND_MAX_DAILY_ATOMIC');
  if (!positiveAtomic(single) || !positiveAtomic(daily) || BigInt(single!) > BigInt(daily!)) {
    return { ready:false, code:'MAINNET_STAKE_REFUND_LIMITS_NOT_READY' } as const;
  }
  const control = await db.prepare('SELECT circuit_open FROM mainnet_stake_refund_control WHERE singleton=1')
    .first<{ circuit_open:number }>();
  if (control?.circuit_open !== 0) return { ready:false, code:'MAINNET_STAKE_REFUND_CIRCUIT_OPEN' } as const;
  return { ready:true, code:'READY' } as const;
}
