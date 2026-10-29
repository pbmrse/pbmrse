import { cancellationPayout } from './business-engine';

// Pure quote only. Does not authorize a refund or send funds.
// The credited principal must equal the verified original USDT payment.
export function quoteMainnetStakeRefund(paymentAtomic: string, creditedPrincipalAtomic: string) {
  if (!/^[1-9][0-9]{0,77}$/.test(paymentAtomic) ||
      !/^[1-9][0-9]{0,77}$/.test(creditedPrincipalAtomic)) throw new Error('INVALID_STAKE_PRINCIPAL');
  const payment = BigInt(paymentAtomic);
  const principal = BigInt(creditedPrincipalAtomic);
  if (payment > (1n << 256n) - 1n || principal !== payment) throw new Error('STAKE_PRINCIPAL_MISMATCH');
  const { fee, returned } = cancellationPayout(principal);
  if (returned <= 0n) throw new Error('REFUND_TOO_SMALL');
  return { principalAtomic: principal.toString(), feeAtomic: fee.toString(), refundAtomic: returned.toString() };
}
