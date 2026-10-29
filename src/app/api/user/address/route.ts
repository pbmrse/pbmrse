/** Legacy testnet address allocation is not available in the mainnet-only deployment. */
export async function POST() {
  return Response.json({ error: 'MAINNET_ADDRESS_ALLOCATION_NOT_READY' }, {
    status: 503,
    headers: { 'Cache-Control': 'no-store', 'Retry-After': '60' },
  });
}
