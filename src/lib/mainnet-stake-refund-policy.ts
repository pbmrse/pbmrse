const UINT256_MAX = (1n << 256n) - 1n;

export type RefundApproval = {
  mode: 'AUTO' | 'MANUAL';
  status: 'APPROVED' | 'PENDING' | 'BLOCKED';
  riskCode: 'NORMAL' | 'SINGLE_LIMIT_EXCEEDED' | 'DAILY_LIMIT_EXCEEDED' |
    'WALLET_DAILY_LIMIT_EXCEEDED' | 'LEDGER_PROVENANCE_CONFLICT' | 'RISK_CIRCUIT_OPEN';
};

export function sumAtomic(rows: { amount_atomic:string }[]): bigint {
  return rows.reduce((total, row) => {
    if (!/^(0|[1-9][0-9]{0,77})$/.test(row.amount_atomic)) throw new Error('INVALID_ATOMIC_LEDGER_VALUE');
    const value = BigInt(row.amount_atomic);
    if (value > UINT256_MAX || total > UINT256_MAX - value) throw new Error('ATOMIC_LEDGER_OVERFLOW');
    return total + value;
  }, 0n);
}

/** Confirmed Chain-56 stake payments must exactly fund current principal plus every cancellation. */
export function stakePrincipalHasConfirmedProvenance(
  confirmedStakeAtomic: bigint, currentPrincipalAtomic: bigint, cancelledGrossAtomic: bigint,
): boolean {
  return confirmedStakeAtomic > 0n && confirmedStakeAtomic === currentPrincipalAtomic + cancelledGrossAtomic;
}

export function classifyStakeRefund(input: {
  provenanceValid: boolean;
  circuitOpen: boolean;
  refundAtomic: bigint;
  walletAutoReservedAtomic: bigint;
  globalAutoReservedAtomic: bigint;
  maximumSingleAtomic: bigint;
  maximumDailyAtomic: bigint;
}): RefundApproval {
  if (!input.provenanceValid) return { mode:'MANUAL', status:'BLOCKED', riskCode:'LEDGER_PROVENANCE_CONFLICT' };
  if (input.circuitOpen) return { mode:'MANUAL', status:'PENDING', riskCode:'RISK_CIRCUIT_OPEN' };
  if (input.refundAtomic > input.maximumSingleAtomic) return { mode:'MANUAL', status:'PENDING', riskCode:'SINGLE_LIMIT_EXCEEDED' };
  if (input.walletAutoReservedAtomic + input.refundAtomic > input.maximumSingleAtomic) {
    return { mode:'MANUAL', status:'PENDING', riskCode:'WALLET_DAILY_LIMIT_EXCEEDED' };
  }
  if (input.globalAutoReservedAtomic + input.refundAtomic > input.maximumDailyAtomic) {
    return { mode:'MANUAL', status:'PENDING', riskCode:'DAILY_LIMIT_EXCEEDED' };
  }
  return { mode:'AUTO', status:'APPROVED', riskCode:'NORMAL' };
}
