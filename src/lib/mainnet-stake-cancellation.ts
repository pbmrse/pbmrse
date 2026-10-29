import { getCloudflareContext } from '@opennextjs/cloudflare';
import { keccak256, toBytes, type Address } from 'viem';
import { BUSINESS } from '@/config/business';
import { cancelStake, settleStaking, type Position } from './business-engine';
import { serverDB } from './server-db';
import { mainnetStakeRefundEnabled, mainnetStakeRefundLimits } from './mainnet-stake-refund-config';
import { classifyStakeRefund, stakePrincipalHasConfirmedProvenance, sumAtomic } from './mainnet-stake-refund-policy';
import { treasuryJobFingerprint } from './treasury-job-policy';
import {
  assertMainnetCancellationTestAccess,
  assertMainnetCancellationTestPosition,
  publicMainnetStakingEnabled,
} from './mainnet-stake-test-gate';

const UINT256_MAX = (1n << 256n) - 1n;

export type MainnetStakeCancellation = {
  cancellation_id: string;
  wallet_address: string;
  amount_atomic: string;
  fee_atomic: string;
  refund_atomic: string;
  remaining_principal_atomic: string;
  status: 'READY' | 'PREPARING' | 'SIGNED' | 'SENT' | 'CONFIRMED' | 'HELD';
  created_at: number;
};

export function normalizeMainnetStakeCancellation(requestId: unknown, amountAtomic: unknown) {
  if (typeof requestId !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(requestId)) {
    throw new Error('INVALID_STAKE_CANCELLATION_REQUEST');
  }
  if (typeof amountAtomic !== 'string' || !/^[1-9][0-9]{0,77}$/.test(amountAtomic) || BigInt(amountAtomic) > UINT256_MAX) {
    throw new Error('INVALID_STAKE_CANCELLATION_AMOUNT');
  }
  const normalized = { chainId: 56, action: 'CANCEL', requestId: requestId.toLowerCase(), amountAtomic } as const;
  return {
    ...normalized,
    purpose: `mainnet-stake-cancel:${keccak256(toBytes(JSON.stringify(normalized)))}`,
  };
}

function response(row: MainnetStakeCancellation, replayed: boolean) {
  return {
    cancellationId: row.cancellation_id,
    walletAddress: row.wallet_address,
    amountAtomic: row.amount_atomic,
    feeAtomic: row.fee_atomic,
    refundAtomic: row.refund_atomic,
    remainingPrincipalAtomic: row.remaining_principal_atomic,
    status: row.status,
    replayed,
  };
}

export async function getMainnetStakePosition(wallet: Address) {
  const env = getCloudflareContext().env;
  if (Reflect.get(env, 'APP_NETWORK') !== 'bsc-mainnet') throw new Error('MAINNET_NETWORK_REQUIRED');
  const row = await serverDB().prepare(
    'SELECT position_json FROM business_positions WHERE wallet_address=? AND chain_id=56',
  ).bind(wallet).first<{ position_json: string }>();
  if (!row) return { walletAddress: wallet, chainId: 56 as const, principalAtomic: '0' };
  try {
    const position = JSON.parse(row.position_json) as Position;
    if (!/^(0|[1-9][0-9]*)$/.test(position.stakePrincipal)) throw new Error();
    return { walletAddress: wallet, chainId: 56 as const, principalAtomic: position.stakePrincipal };
  } catch {
    throw new Error('MAINNET_STAKE_POSITION_INVALID');
  }
}

export async function cancelMainnetStake(
  wallet: Address,
  action: ReturnType<typeof normalizeMainnetStakeCancellation>,
) {
  const env = getCloudflareContext().env;
  if (Reflect.get(env, 'APP_NETWORK') !== 'bsc-mainnet' ||
      Reflect.get(env, 'MAINNET_STAKING_LIFECYCLE_READY') !== 'true') {
    throw new Error('MAINNET_STAKING_NOT_READY');
  }
  if (!mainnetStakeRefundEnabled()) throw new Error('MAINNET_STAKE_REFUND_NOT_READY');
  const treasury = Reflect.get(env, 'MAINNET_TREASURY_ADDRESS');
  if (typeof treasury !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(treasury) || /^0x0{40}$/i.test(treasury)) {
    throw new Error('MAINNET_TREASURY_NOT_CONFIGURED');
  }
  const db = serverDB();
  const cancellationId = `stake-cancel:${wallet.toLowerCase()}:${action.requestId}`;
  const existing = await db.prepare(
    'SELECT cancellation_id,wallet_address,amount_atomic,fee_atomic,refund_atomic,remaining_principal_atomic,status,created_at FROM mainnet_stake_cancellations WHERE cancellation_id=? AND chain_id=56 AND lower(wallet_address)=lower(?)',
  ).bind(cancellationId, wallet).first<MainnetStakeCancellation>();
  if (existing) {
    if (existing.amount_atomic !== action.amountAtomic) throw new Error('STAKE_CANCELLATION_REPLAY_CONFLICT');
    const existingJob = await db.prepare(`SELECT job_id FROM bank_transaction_queue
      WHERE job_id=? AND operation_id=? AND owner_wallet=? AND recipient_address=? AND chain_id=56
        AND sender_kind='TREASURY' AND lower(sender_address)=lower(?) AND asset='USDT' AND amount_atomic=?
        AND status IN ('PENDING','PREPARING','SIGNED','SENT','CONFIRMED','HELD')`)
      .bind(`stake-refund:${cancellationId}`, cancellationId, wallet, wallet, treasury, existing.refund_atomic).first<{ job_id:string }>();
    if (!existingJob) throw new Error('STAKE_CANCELLATION_REPLAY_REQUIRES_RECONCILIATION');
    return response(existing, true);
  }

  const limits = mainnetStakeRefundLimits();
  const requested = BigInt(action.amountAtomic);
  const acceptancePhase=publicMainnetStakingEnabled(env as Record<string,unknown>)
    ? null
    : assertMainnetCancellationTestAccess(env as Record<string,unknown>,wallet,action.amountAtomic);

  const row = await db.prepare(
    'SELECT position_json,version FROM business_positions WHERE wallet_address=? AND chain_id=56',
  ).bind(wallet).first<{ position_json: string; version: number }>();
  if (!row || !Number.isSafeInteger(row.version) || row.version < 0) throw new Error('MAINNET_STAKE_POSITION_NOT_FOUND');

  const now = Date.now();
  const day = new Date(now).toISOString().slice(0, 10);
  await db.prepare(
    "INSERT OR IGNORE INTO mainnet_stake_refund_days(day_utc,reserved_atomic,confirmed_atomic,version,updated_at,auto_reserved_atomic) VALUES (?,'0','0',0,?,'0')",
  ).bind(day, now).run();
  await db.prepare(
    "INSERT OR IGNORE INTO mainnet_stake_refund_wallet_days(day_utc,wallet_address,auto_reserved_atomic,version,updated_at) VALUES (?,?,'0',0,?)",
  ).bind(day, wallet, now).run();
  const [daily, walletDaily, control, confirmedRows, cancelledRows] = await Promise.all([
    db.prepare('SELECT reserved_atomic,auto_reserved_atomic,version FROM mainnet_stake_refund_days WHERE day_utc=?')
      .bind(day).first<{ reserved_atomic:string; auto_reserved_atomic:string; version:number }>(),
    db.prepare('SELECT auto_reserved_atomic,version FROM mainnet_stake_refund_wallet_days WHERE day_utc=? AND lower(wallet_address)=lower(?)')
      .bind(day, wallet).first<{ auto_reserved_atomic:string; version:number }>(),
    db.prepare('SELECT circuit_open FROM mainnet_stake_refund_control WHERE singleton=1').first<{ circuit_open:number }>(),
    db.prepare("SELECT principal_atomic AS amount_atomic FROM mainnet_stake_credits WHERE lower(wallet_address)=lower(?)")
      .bind(wallet).all<{ amount_atomic:string }>(),
    db.prepare('SELECT amount_atomic FROM mainnet_stake_cancellations WHERE chain_id=56 AND lower(wallet_address)=lower(?)')
      .bind(wallet).all<{ amount_atomic:string }>(),
  ]);
  if (!daily || !walletDaily ||
      !/^(0|[1-9][0-9]*)$/.test(daily.reserved_atomic) || !/^(0|[1-9][0-9]*)$/.test(daily.auto_reserved_atomic) ||
      !/^(0|[1-9][0-9]*)$/.test(walletDaily.auto_reserved_atomic) ||
      !Number.isSafeInteger(daily.version) || daily.version < 0 ||
      !Number.isSafeInteger(walletDaily.version) || walletDaily.version < 0) {
    throw new Error('STAKE_REFUND_DAILY_LEDGER_INVALID');
  }
  let position: Position;
  try { position = settleStaking(JSON.parse(row.position_json) as Position, now, BUSINESS.stakingDailyRateBps); }
  catch { throw new Error('MAINNET_STAKE_POSITION_INVALID'); }
  if (acceptancePhase) assertMainnetCancellationTestPosition(acceptancePhase,position.stakePrincipal);
  const amount = requested;
  const cancelled = cancelStake(position, amount);
  const confirmedStakeAtomic = sumAtomic(confirmedRows.results);
  const priorCancelledAtomic = sumAtomic(cancelledRows.results);
  const provenanceValid = stakePrincipalHasConfirmedProvenance(
    confirmedStakeAtomic, BigInt(position.stakePrincipal), priorCancelledAtomic,
  );
  const approval = classifyStakeRefund({
    provenanceValid,
    circuitOpen:control?.circuit_open !== 0,
    refundAtomic:cancelled.returned,
    walletAutoReservedAtomic:BigInt(walletDaily.auto_reserved_atomic),
    globalAutoReservedAtomic:BigInt(daily.auto_reserved_atomic),
    maximumSingleAtomic:limits.maximumSingleAtomic,
    maximumDailyAtomic:limits.maximumDailyAtomic,
  });
  const nextDailyReserved = BigInt(daily.reserved_atomic) + cancelled.returned;
  const nextAutoReserved = BigInt(daily.auto_reserved_atomic) + (approval.mode === 'AUTO' ? cancelled.returned : 0n);
  const nextWalletAutoReserved = BigInt(walletDaily.auto_reserved_atomic) + (approval.mode === 'AUTO' ? cancelled.returned : 0n);
  const remaining = cancelled.position.stakePrincipal;
  const details = JSON.stringify({
    grossAtomic: action.amountAtomic,
    feeAtomic: cancelled.fee.toString(),
    refundAtomic: cancelled.returned.toString(),
    feeDisposition: 'PLATFORM_INTERNAL',
    referralPgrRetained: true,
    authorizationMode: approval.mode,
    riskCode: approval.riskCode,
  });
  const refundJobId = `stake-refund:${cancellationId}`;
  const refundJobFingerprint = treasuryJobFingerprint({
    job_id: refundJobId, operation_id: cancellationId, owner_wallet: wallet,
    sender_kind: 'TREASURY', sender_address: treasury, recipient_address: wallet,
    chain_id: 56, asset: 'USDT', amount_atomic: cancelled.returned.toString(), created_at: now,
  });

  const ready = approval.status === 'APPROVED';
  const authorizationExpiresAt = now + 24 * 60 * 60 * 1000;
  const writes = await db.batch([
    db.prepare(`UPDATE business_positions SET position_json=?,version=version+1,updated_at=?,last_operation_id=?
      WHERE wallet_address=? AND chain_id=56 AND version=?
      AND EXISTS(SELECT 1 FROM mainnet_stake_refund_days WHERE day_utc=? AND version=?)
      AND EXISTS(SELECT 1 FROM mainnet_stake_refund_wallet_days WHERE day_utc=? AND lower(wallet_address)=lower(?) AND version=?)
      AND NOT EXISTS(SELECT 1 FROM mainnet_stake_cancellations WHERE cancellation_id=?)`)
      .bind(JSON.stringify(cancelled.position), now, cancellationId, wallet, row.version, day, daily.version,
        day, wallet, walletDaily.version, cancellationId),
    db.prepare(`INSERT INTO mainnet_stake_cancellations
      (cancellation_id,request_id,wallet_address,chain_id,amount_atomic,fee_atomic,refund_atomic,remaining_principal_atomic,status,created_at,reserved_day,last_error)
      SELECT ?,?,?,56,?,?,?,?,?,?,?,?
      WHERE EXISTS(SELECT 1 FROM business_positions WHERE wallet_address=? AND chain_id=56 AND last_operation_id=?)
      ON CONFLICT(cancellation_id) DO NOTHING`)
      .bind(cancellationId, action.requestId, wallet, action.amountAtomic, cancelled.fee.toString(), cancelled.returned.toString(), remaining,
        ready ? 'READY' : 'HELD', now, day, ready ? null : approval.riskCode, wallet, cancellationId),
    db.prepare(`INSERT INTO business_operations
      (operation_id,wallet_address,chain_id,operation_type,amount_atomic,asset,status,created_at,details_json)
      SELECT cancellation_id,wallet_address,56,'STAKE_CANCEL',amount_atomic,'USDT',status,created_at,?
      FROM mainnet_stake_cancellations WHERE cancellation_id=? AND chain_id=56
      ON CONFLICT(operation_id) DO NOTHING`).bind(details, cancellationId),
    db.prepare(`UPDATE mainnet_stake_refund_days SET reserved_atomic=?,auto_reserved_atomic=?,version=version+1,updated_at=?
      WHERE day_utc=? AND version=?
      AND EXISTS(SELECT 1 FROM mainnet_stake_cancellations WHERE cancellation_id=? AND chain_id=56 AND reserved_day=?)`)
      .bind(nextDailyReserved.toString(), nextAutoReserved.toString(), now, day, daily.version, cancellationId, day),
    db.prepare(`UPDATE mainnet_stake_refund_wallet_days SET auto_reserved_atomic=?,version=version+1,updated_at=?
      WHERE day_utc=? AND lower(wallet_address)=lower(?) AND version=?
      AND EXISTS(SELECT 1 FROM mainnet_stake_cancellations WHERE cancellation_id=? AND chain_id=56 AND reserved_day=?)`)
      .bind(nextWalletAutoReserved.toString(), now, day, wallet, walletDaily.version, cancellationId, day),
    db.prepare(`INSERT INTO bank_transaction_queue
      (job_id,operation_id,owner_wallet,sender_kind,sender_address,recipient_address,chain_id,asset,amount_atomic,status,created_at,job_fingerprint)
      SELECT 'stake-refund:'||cancellation_id,cancellation_id,wallet_address,'TREASURY',?,wallet_address,56,'USDT',refund_atomic,?,created_at,?
      FROM mainnet_stake_cancellations
      WHERE cancellation_id=? AND chain_id=56 AND lower(wallet_address)=lower(?)
        AND amount_atomic=? AND fee_atomic=? AND refund_atomic=?
      ON CONFLICT(job_id) DO NOTHING`)
      .bind(treasury.toLowerCase(), ready ? 'PENDING' : 'HELD', refundJobFingerprint, cancellationId, wallet,
        action.amountAtomic, cancelled.fee.toString(), cancelled.returned.toString()),
    db.prepare(`INSERT INTO treasury_job_authorizations
      (job_id,job_fingerprint,authorization_mode,authorization_status,risk_code,policy_version,authorized_by,authorized_at,expires_at,created_at)
      SELECT job_id,job_fingerprint,?,?,?,'stake-refund-v1',?,?,?,?
      FROM bank_transaction_queue WHERE job_id=? AND chain_id=56
      ON CONFLICT(job_id) DO NOTHING`)
      .bind(approval.mode, approval.status, approval.riskCode, ready ? 'SYSTEM' : null, ready ? now : null,
        authorizationExpiresAt, now, refundJobId),
  ]);

  if (writes.length !== 7 || writes.some(result => !result.meta) || writes.some(result => result.meta.changes !== 1)) {
    const replay = await db.prepare(
      'SELECT cancellation_id,wallet_address,amount_atomic,fee_atomic,refund_atomic,remaining_principal_atomic,status,created_at FROM mainnet_stake_cancellations WHERE cancellation_id=? AND chain_id=56 AND lower(wallet_address)=lower(?)',
    ).bind(cancellationId, wallet).first<MainnetStakeCancellation>();
    const replayJob = replay ? await db.prepare(`SELECT job_id FROM bank_transaction_queue
      WHERE job_id=? AND operation_id=? AND owner_wallet=? AND recipient_address=? AND chain_id=56
        AND sender_kind='TREASURY' AND lower(sender_address)=lower(?) AND asset='USDT' AND amount_atomic=?
        AND status IN ('PENDING','PREPARING','SIGNED','SENT','CONFIRMED','HELD')`)
      .bind(`stake-refund:${cancellationId}`, cancellationId, wallet, wallet, treasury, replay.refund_atomic).first<{ job_id:string }>() : null;
    if (replay && replay.amount_atomic === action.amountAtomic && replayJob) return response(replay, true);
    throw new Error('STAKE_CANCELLATION_CONFLICT_RECONCILIATION_REQUIRED');
  }
  const saved = await db.prepare(
    'SELECT cancellation_id,wallet_address,amount_atomic,fee_atomic,refund_atomic,remaining_principal_atomic,status,created_at FROM mainnet_stake_cancellations WHERE cancellation_id=? AND chain_id=56 AND lower(wallet_address)=lower(?)',
  ).bind(cancellationId, wallet).first<MainnetStakeCancellation>();
  if (!saved || saved.amount_atomic !== action.amountAtomic || saved.fee_atomic !== cancelled.fee.toString() ||
      saved.refund_atomic !== cancelled.returned.toString() || saved.remaining_principal_atomic !== remaining ||
      saved.status !== (ready ? 'READY' : 'HELD')) {
    throw new Error('STAKE_CANCELLATION_RECORD_REQUIRES_RECONCILIATION');
  }
  return response(saved, false);
}
