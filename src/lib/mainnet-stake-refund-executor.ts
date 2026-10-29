import { getCloudflareContext } from '@opennextjs/cloudflare';
import { type Hash } from 'viem';
import { processMainnetBankJob } from './mainnet-bank-payouts';
import { serverDB, type Database } from './server-db';
import { mainnetStakeRefundEnabled, mainnetStakeRefundLimits } from './mainnet-stake-refund-config';

type Refund = {
  cancellation_id: string; wallet_address: string; amount_atomic: string; fee_atomic: string;
  refund_atomic: string; status: string; tx_hash: Hash | null; confirmed_at: number | null;
  failure_count: number; reserved_day: string;
};
type TreasuryJob = {
  job_id: string; operation_id: string; owner_wallet: string; sender_kind: string;
  sender_address: string; recipient_address: string; chain_id: number; asset: string;
  amount_atomic: string; status: string; tx_hash: Hash | null; last_error: string | null;
};
type JobAuthorization = {
  authorization_mode:string; authorization_status:string; risk_code:string; expires_at:number;
};

async function sendAlert(cancellationId: string, reason: string) {
  console.error(JSON.stringify({ event:'mainnet_stake_refund_alert', cancellationId, reason, chainId:56 }));
  const value = Reflect.get(getCloudflareContext().env, 'MAINNET_STAKE_REFUND_ALERT_WEBHOOK');
  if (typeof value !== 'string' || !value.startsWith('https://')) return;
  try {
    await fetch(value, {
      method:'POST', headers:{ 'Content-Type':'application/json' },
      body:JSON.stringify({ event:'mainnet_stake_refund_circuit_open', cancellationId, reason, chainId:56 }),
      signal:AbortSignal.timeout(5000),
    });
  } catch {
    console.error(JSON.stringify({ event:'mainnet_stake_refund_alert_failed', cancellationId }));
  }
}

async function holdAndOpenCircuit(db: Database, cancellationId: string, reason: string) {
  const now = Date.now();
  await db.batch([
    db.prepare("UPDATE mainnet_stake_cancellations SET status='HELD',last_error=? WHERE cancellation_id=? AND chain_id=56 AND status<>'CONFIRMED'").bind(reason, cancellationId),
    db.prepare("UPDATE business_operations SET status='HELD' WHERE operation_id=? AND chain_id=56 AND status<>'CONFIRMED'").bind(cancellationId),
    db.prepare("UPDATE bank_transaction_queue SET status='HELD',last_error=? WHERE job_id=? AND chain_id=56 AND status<>'CONFIRMED'").bind(reason, `stake-refund:${cancellationId}`),
    db.prepare('UPDATE mainnet_stake_refund_control SET circuit_open=1,reason=?,updated_at=? WHERE singleton=1').bind(reason, now),
  ]);
  await sendAlert(cancellationId, reason);
  return { processed:false, reason:'held_circuit_open' as const };
}

async function recordTransientFailure(db: Database, refund: Refund, reason: string) {
  const updated = await db.prepare("UPDATE mainnet_stake_cancellations SET failure_count=failure_count+1,last_error=? WHERE cancellation_id=? AND chain_id=56 AND status IN ('READY','PREPARING','SIGNED','SENT') RETURNING failure_count")
    .bind(reason, refund.cancellation_id).first<{ failure_count:number }>();
  if (updated && updated.failure_count >= 3) return holdAndOpenCircuit(db, refund.cancellation_id, 'REPEATED_TREASURY_EXECUTION_FAILURE');
  return { processed:false, reason:'treasury_execution_pending' as const };
}

async function finalizeConfirmed(db: Database, refund: Refund, job: TreasuryJob) {
  if (!job.tx_hash) return holdAndOpenCircuit(db, refund.cancellation_id, 'CONFIRMED_TREASURY_JOB_MISSING_HASH');
  if (refund.status === 'CONFIRMED') {
    if (refund.tx_hash?.toLowerCase() !== job.tx_hash.toLowerCase()) return holdAndOpenCircuit(db, refund.cancellation_id, 'CONFIRMED_REFUND_HASH_CHANGED');
    return { processed:false, reason:'confirmed' as const };
  }
  const day = await db.prepare('SELECT confirmed_atomic,version FROM mainnet_stake_refund_days WHERE day_utc=?')
    .bind(refund.reserved_day).first<{ confirmed_atomic:string; version:number }>();
  if (!day || !/^(0|[1-9][0-9]*)$/.test(day.confirmed_atomic) || !Number.isSafeInteger(day.version)) {
    return holdAndOpenCircuit(db, refund.cancellation_id, 'REFUND_DAILY_CONFIRMATION_LEDGER_INVALID');
  }
  const now = Date.now(), nextConfirmed = BigInt(day.confirmed_atomic) + BigInt(refund.refund_atomic);
  const writes = await db.batch([
    db.prepare(`UPDATE mainnet_stake_cancellations SET status='CONFIRMED',tx_hash=?,confirmed_at=?,last_error=NULL
      WHERE cancellation_id=? AND chain_id=56 AND status IN ('READY','PREPARING','SIGNED','SENT')
      AND EXISTS(SELECT 1 FROM bank_transaction_queue WHERE job_id=? AND chain_id=56 AND status='CONFIRMED' AND tx_hash=?)
      AND EXISTS(SELECT 1 FROM mainnet_stake_refund_days WHERE day_utc=? AND version=?)`)
      .bind(job.tx_hash, now, refund.cancellation_id, job.job_id, job.tx_hash, refund.reserved_day, day.version),
    db.prepare(`UPDATE mainnet_stake_refund_days SET confirmed_atomic=?,version=version+1,updated_at=?
      WHERE day_utc=? AND version=? AND EXISTS(SELECT 1 FROM mainnet_stake_cancellations WHERE cancellation_id=? AND status='CONFIRMED' AND tx_hash=?)`)
      .bind(nextConfirmed.toString(), now, refund.reserved_day, day.version, refund.cancellation_id, job.tx_hash),
    db.prepare(`UPDATE business_operations SET status='CONFIRMED',tx_hash=?
      WHERE operation_id=? AND wallet_address=? AND chain_id=56 AND operation_type='STAKE_CANCEL' AND status<>'CONFIRMED'
      AND EXISTS(SELECT 1 FROM mainnet_stake_cancellations WHERE cancellation_id=business_operations.operation_id AND status='CONFIRMED' AND tx_hash=?)`)
      .bind(job.tx_hash, refund.cancellation_id, refund.wallet_address, job.tx_hash),
  ]);
  if (writes.length !== 3 || writes.some(result => result.meta?.changes !== 1)) return holdAndOpenCircuit(db, refund.cancellation_id, 'REFUND_CONFIRMATION_LEDGER_MISMATCH');
  return { processed:true, status:'CONFIRMED' as const };
}

export async function processMainnetStakeRefund(cancellationId: string) {
  if (!mainnetStakeRefundEnabled()) throw new Error('Mainnet stake refunds are disabled');
  const db = serverDB();
  const refund = await db.prepare('SELECT * FROM mainnet_stake_cancellations WHERE cancellation_id=? AND chain_id=56').bind(cancellationId).first<Refund>();
  if (!refund) return { processed:false, reason:'not_found' as const };
  if (refund.status === 'HELD') return { processed:false, reason:'held' as const };
  const jobId = `stake-refund:${cancellationId}`;
  let job = await db.prepare('SELECT * FROM bank_transaction_queue WHERE job_id=? AND chain_id=56').bind(jobId).first<TreasuryJob>();
  if (!job) return holdAndOpenCircuit(db, cancellationId, 'TREASURY_REFUND_JOB_MISSING');
  // A terminal refund is already fully reconciled. Its authorization may
  // legitimately expire later, so never re-run the release gate for it.
  if (refund.status === 'CONFIRMED') {
    if (job.status !== 'CONFIRMED') return holdAndOpenCircuit(db, cancellationId, 'CONFIRMED_REFUND_JOB_NOT_CONFIRMED');
    return finalizeConfirmed(db, refund, job);
  }

  const limits = mainnetStakeRefundLimits();
  const gross = BigInt(refund.amount_atomic), fee = BigInt(refund.fee_atomic), net = BigInt(refund.refund_atomic);
  const [day, walletDay, control, authorization] = await Promise.all([
    db.prepare('SELECT reserved_atomic,auto_reserved_atomic FROM mainnet_stake_refund_days WHERE day_utc=?')
      .bind(refund.reserved_day).first<{ reserved_atomic:string; auto_reserved_atomic:string }>(),
    db.prepare('SELECT auto_reserved_atomic FROM mainnet_stake_refund_wallet_days WHERE day_utc=? AND lower(wallet_address)=lower(?)')
      .bind(refund.reserved_day, refund.wallet_address).first<{ auto_reserved_atomic:string }>(),
    db.prepare('SELECT circuit_open FROM mainnet_stake_refund_control WHERE singleton=1').first<{ circuit_open:number }>(),
    db.prepare('SELECT authorization_mode,authorization_status,risk_code,expires_at FROM treasury_job_authorizations WHERE job_id=?')
      .bind(jobId).first<JobAuthorization>(),
  ]);
  const autoLimitsValid = authorization?.authorization_mode !== 'AUTO' || (
    authorization.risk_code === 'NORMAL' && net <= limits.maximumSingleAtomic && !!day && !!walletDay &&
    /^(0|[1-9][0-9]*)$/.test(day.auto_reserved_atomic) && /^(0|[1-9][0-9]*)$/.test(walletDay.auto_reserved_atomic) &&
    BigInt(day.auto_reserved_atomic) <= limits.maximumDailyAtomic && BigInt(walletDay.auto_reserved_atomic) <= limits.maximumSingleAtomic
  );
  const authorized = job.operation_id === cancellationId && job.owner_wallet.toLowerCase() === refund.wallet_address.toLowerCase() &&
    job.recipient_address.toLowerCase() === refund.wallet_address.toLowerCase() && job.sender_kind === 'TREASURY' && job.chain_id === 56 &&
    job.asset === 'USDT' && job.amount_atomic === refund.refund_atomic && fee + net === gross && fee === gross * 200n / 10000n &&
    !!day && /^(0|[1-9][0-9]*)$/.test(day.reserved_atomic) && !!authorization &&
    authorization.authorization_status === 'APPROVED' && authorization.expires_at >= Date.now() &&
    ['AUTO','MANUAL'].includes(authorization.authorization_mode) && autoLimitsValid;
  if (!authorized) return holdAndOpenCircuit(db, cancellationId, 'UNAUTHORIZED_OR_INVALID_TREASURY_REFUND_JOB');
  if (control?.circuit_open !== 0) return { processed:false, reason:'circuit_open' as const };

  if (job.status !== 'CONFIRMED') {
    try {
      const result = await processMainnetBankJob(jobId);
      if (!result.processed && ['insufficient_token_balance','insufficient_gas_balance','broadcast_pending'].includes(result.reason ?? '')) {
        return recordTransientFailure(db, refund, result.reason ?? 'TREASURY_EXECUTION_FAILURE');
      }
    } catch (error) {
      return recordTransientFailure(db, refund, error instanceof Error ? error.name : 'TreasuryExecutionError');
    }
    job = await db.prepare('SELECT * FROM bank_transaction_queue WHERE job_id=? AND chain_id=56').bind(jobId).first<TreasuryJob>();
    if (!job) return holdAndOpenCircuit(db, cancellationId, 'TREASURY_REFUND_JOB_DISAPPEARED');
  }
  if (['HELD','FAILED','REJECTED'].includes(job.status)) return holdAndOpenCircuit(db, cancellationId, job.last_error ?? 'TREASURY_REFUND_JOB_HELD');
  if (job.status === 'CONFIRMED') return finalizeConfirmed(db, refund, job);
  if (['PREPARING','SIGNED','SENT'].includes(job.status)) {
    await db.prepare("UPDATE mainnet_stake_cancellations SET status=?,tx_hash=?,last_error=NULL WHERE cancellation_id=? AND chain_id=56 AND status IN ('READY','PREPARING','SIGNED','SENT')")
      .bind(job.status, job.tx_hash, cancellationId).run();
  }
  return { processed:true, status:job.status };
}

export async function pumpMainnetStakeRefunds(limit = 3) {
  if (!mainnetStakeRefundEnabled()) return { processed:0 };
  const db = serverDB();
  const jobs = await db.prepare(`SELECT q.operation_id FROM bank_transaction_queue q
    JOIN mainnet_stake_cancellations c ON c.cancellation_id=q.operation_id AND c.chain_id=q.chain_id
    WHERE q.chain_id=56 AND q.job_id='stake-refund:'||q.operation_id AND q.operation_id LIKE 'stake-cancel:%'
    AND q.status IN ('PENDING','PREPARING','SIGNED','SENT','CONFIRMED') AND c.status<>'CONFIRMED'
    ORDER BY CASE q.status WHEN 'SENT' THEN 0 WHEN 'SIGNED' THEN 1 WHEN 'PREPARING' THEN 2 WHEN 'PENDING' THEN 3 ELSE 4 END,q.created_at LIMIT ?`)
    .bind(Math.max(1, Math.min(10, limit))).all<{ operation_id:string }>();
  let processed = 0;
  for (const job of jobs.results) {
    try { if ((await processMainnetStakeRefund(job.operation_id)).processed) processed++; }
    catch (error) { console.error(JSON.stringify({ event:'mainnet_stake_refund_retry', cancellationId:job.operation_id, error:error instanceof Error ? error.name : 'UnknownError' })); }
  }
  return { processed };
}
