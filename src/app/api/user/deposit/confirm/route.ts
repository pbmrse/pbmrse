/** Legacy deposit confirmation is disabled until a dedicated mainnet deposit flow is accepted. */
export async function POST() {
  return Response.json({ error: 'MAINNET_DEPOSIT_CONFIRMATION_NOT_READY' }, {
    status: 503,
    headers: { 'Cache-Control': 'no-store', 'Retry-After': '60' },
  });
}
