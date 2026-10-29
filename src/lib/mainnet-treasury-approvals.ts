import { getCloudflareContext } from '@opennextjs/cloudflare';
import { serverDB } from './server-db';

type Authorization = {
  job_id:string; job_fingerprint:string; authorization_mode:string; authorization_status:string;
  risk_code:string; expires_at:number;
};

function approvalQuorum(): number {
  const value = Reflect.get(getCloudflareContext().env, 'MAINNET_TREASURY_APPROVAL_QUORUM');
  if (typeof value !== 'string' || !/^[2-9]$/.test(value)) throw new Error('TREASURY_APPROVAL_QUORUM_INVALID');
  return Number(value);
}

/**
 * Records one authorized administrator's approval for a held exceptional refund.
 * This does not sign or broadcast. The Signer independently revalidates the
 * immutable job, business source, risk state, quorum and all financial gates.
 */
export async function approveExceptionalTreasuryRefund(jobId: string, approverId: string) {
  if (Reflect.get(getCloudflareContext().env, 'APP_NETWORK') !== 'bsc-mainnet') throw new Error('MAINNET_NETWORK_REQUIRED');
  if (!/^stake-refund:stake-cancel:[a-zA-Z0-9:_.-]{8,220}$/.test(jobId) ||
      !/^[a-zA-Z0-9:_.-]{3,100}$/.test(approverId)) throw new Error('INVALID_TREASURY_APPROVAL');
  const db = serverDB(), now = Date.now(), quorum = approvalQuorum();
  const authorization = await db.prepare(`SELECT job_id,job_fingerprint,authorization_mode,authorization_status,risk_code,expires_at
    FROM treasury_job_authorizations WHERE job_id=?`).bind(jobId).first<Authorization>();
  if (!authorization || authorization.authorization_mode !== 'MANUAL' ||
      !['PENDING','APPROVED'].includes(authorization.authorization_status) || authorization.expires_at < now ||
      authorization.risk_code === 'LEDGER_PROVENANCE_CONFLICT') throw new Error('TREASURY_JOB_NOT_APPROVABLE');
  const admin = await db.prepare('SELECT active FROM treasury_authorized_approvers WHERE approver_id=?')
    .bind(approverId).first<{active:number}>();
  if (admin?.active !== 1) throw new Error('TREASURY_APPROVER_NOT_AUTHORIZED');
  const existing = await db.prepare('SELECT approved_at FROM treasury_payout_approvals WHERE job_id=? AND approver_id=?')
    .bind(jobId, approverId).first<{approved_at:number}>();
  if (!existing) {
    const auditId=`treasury-approval:${jobId}:${approverId}`;
    const action=JSON.stringify({kind:'APPROVE_EXCEPTIONAL_REFUND',jobId,jobFingerprint:authorization.job_fingerprint,riskCode:authorization.risk_code});
    const recorded=await db.batch([
      db.prepare(`INSERT INTO treasury_payout_approvals
        (job_id,approver_id,job_fingerprint,approved_at,expires_at) VALUES (?,?,?,?,?)`)
        .bind(jobId, approverId, authorization.job_fingerprint, now, authorization.expires_at),
      db.prepare('INSERT INTO bank_admin_audit(action_id,admin_wallet,action_json,created_at) VALUES (?,?,?,?)')
        .bind(auditId,approverId,action,now),
    ]);
    if(recorded.length!==2||recorded.some(result=>result.meta.changes!==1))throw new Error('TREASURY_APPROVAL_AUDIT_FAILED');
  }
  const approvals = await db.prepare(`SELECT COUNT(DISTINCT approval.approver_id) count
    FROM treasury_payout_approvals approval
    JOIN treasury_authorized_approvers admin ON admin.approver_id=approval.approver_id AND admin.active=1
    WHERE approval.job_id=? AND lower(approval.job_fingerprint)=lower(?)
      AND approval.revoked_at IS NULL AND approval.approved_at<=? AND approval.expires_at>=?`)
    .bind(jobId, authorization.job_fingerprint, now, now).first<{count:number}>();
  const count = approvals?.count ?? 0;
  if (count < quorum) return { approved:false, approvals:count, quorum };
  if (authorization.authorization_status === 'APPROVED') return { approved:true, approvals:count, quorum };

  const writes = await db.batch([
    db.prepare(`UPDATE treasury_job_authorizations SET authorization_status='APPROVED',authorized_by='ADMIN_QUORUM',authorized_at=?
      WHERE job_id=? AND authorization_mode='MANUAL' AND authorization_status='PENDING' AND expires_at>=?`)
      .bind(now, jobId, now),
    db.prepare(`UPDATE bank_transaction_queue SET status='PENDING',last_error=NULL
      WHERE job_id=? AND chain_id=56 AND status='HELD' AND nonce IS NULL AND raw_transaction IS NULL AND tx_hash IS NULL
      AND EXISTS(SELECT 1 FROM treasury_job_authorizations WHERE job_id=? AND authorization_status='APPROVED')`)
      .bind(jobId, jobId),
    db.prepare(`UPDATE mainnet_stake_cancellations SET status='READY',last_error=NULL
      WHERE cancellation_id=substr(?,length('stake-refund:')+1) AND chain_id=56 AND status='HELD'
      AND EXISTS(SELECT 1 FROM bank_transaction_queue WHERE job_id=? AND status='PENDING')`)
      .bind(jobId, jobId),
    db.prepare(`UPDATE business_operations SET status='READY'
      WHERE operation_id=substr(?,length('stake-refund:')+1) AND chain_id=56 AND operation_type='STAKE_CANCEL' AND status='HELD'
      AND EXISTS(SELECT 1 FROM mainnet_stake_cancellations
        WHERE cancellation_id=business_operations.operation_id AND status='READY')`)
      .bind(jobId),
  ]);
  if (writes.length !== 4 || writes.some(result => result.meta.changes !== 1)) {
    throw new Error('TREASURY_MANUAL_APPROVAL_RECONCILIATION_REQUIRED');
  }
  return { approved:true, approvals:count, quorum };
}
