/** Legacy chain-97 bank-operation status is retired from the mainnet-only deployment. */
export async function GET() {
  return Response.json({ error: 'MAINNET_BANK_OPERATION_STATUS_NOT_READY' }, {
    status: 503,
    headers: { 'Cache-Control': 'no-store', 'Retry-After': '60' },
  });
}
