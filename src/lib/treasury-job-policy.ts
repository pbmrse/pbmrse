import { keccak256, stringToHex } from 'viem';

export type TreasuryJobPolicyRecord = {
  job_id: string;
  operation_id: string | null;
  owner_wallet: string;
  sender_kind: string;
  sender_address: string;
  recipient_address: string;
  chain_id: number;
  asset: string;
  amount_atomic: string;
  created_at: number;
};

/** Stable approval fingerprint. Never include mutable queue status or RPC data. */
export function treasuryJobFingerprint(job: TreasuryJobPolicyRecord): `0x${string}` {
  const canonical = [
    'PBMRESERVES_TREASURY_JOB_V1', job.job_id, job.operation_id ?? '',
    job.owner_wallet.toLowerCase(), job.sender_kind,
    job.sender_address.toLowerCase(), job.recipient_address.toLowerCase(),
    String(job.chain_id), job.asset, job.amount_atomic, String(job.created_at),
  ].join('|');
  return keccak256(stringToHex(canonical));
}

export function validTreasuryJobIdentity(job: TreasuryJobPolicyRecord): boolean {
  return job.chain_id === 56 && job.asset === 'USDT' && job.sender_kind === 'TREASURY' &&
    /^0x[0-9a-fA-F]{40}$/.test(job.sender_address) &&
    /^0x[0-9a-fA-F]{40}$/.test(job.recipient_address) &&
    !/^0x0{40}$/i.test(job.sender_address) && !/^0x0{40}$/i.test(job.recipient_address) &&
    job.owner_wallet.toLowerCase() === job.recipient_address.toLowerCase() &&
    /^[1-9][0-9]{0,77}$/.test(job.amount_atomic) && BigInt(job.amount_atomic) <= (1n << 256n) - 1n &&
    Number.isSafeInteger(job.created_at) && job.created_at > 0;
}
