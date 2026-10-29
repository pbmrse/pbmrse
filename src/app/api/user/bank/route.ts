/** Legacy bank endpoint retired on BSC mainnet.
 * Do not route Chain 56 funds through the Chain 97 internal balance ledger.
 * Dedicated mainnet staking/refund endpoints must replace this route after
 * transaction-receipt and idempotency acceptance.
 */
export async function POST(request: Request) {
  let chainId: unknown;
  try {
    const body = await request.json() as { chainId?: unknown };
    chainId = body.chainId;
  } catch {
    return Response.json({ error: 'INVALID_REQUEST' }, { status: 400, headers: { 'Cache-Control': 'no-store' } });
  }
  if (chainId !== 56) {
    return Response.json({ error: 'BSC_MAINNET_CHAIN_56_REQUIRED' }, { status: 400, headers: { 'Cache-Control': 'no-store' } });
  }
  return Response.json({ error: 'MAINNET_STAKING_REFUND_NOT_READY' }, { status: 503, headers: { 'Cache-Control': 'no-store', 'Retry-After': '60' } });
}
