import { authenticateWallet, type WalletProof } from '@/lib/wallet-auth';
import { mainnetCustodyAddress } from '@/lib/mainnet-custody-address';
import { getCloudflareContext } from '@opennextjs/cloudflare';
import {assertMainnetFixedAddressTestAccess} from '@/lib/mainnet-stake-test-gate';

export async function POST(request: Request) {
  try {
    if (Reflect.get(getCloudflareContext().env, 'APP_NETWORK') !== 'bsc-mainnet')
      return Response.json({ error: 'MAINNET_NETWORK_REQUIRED' }, { status: 503 });
    const body = await request.json() as WalletProof & { chainId?: number };
    if (body.chainId !== 56) {
      return Response.json({ error: 'Mainnet deposit addresses require Chain ID 56' }, { status: 400 });
    }
    let wallet;
    try {
      wallet = await authenticateWallet(body, 'mainnet-deposit-address');
    } catch {
      return Response.json({ error: 'Wallet authorization failed' }, { status: 401 });
    }
    try{assertMainnetFixedAddressTestAccess(getCloudflareContext().env as Record<string,unknown>,wallet);}
    catch{return Response.json({error:'MAINNET_STAKE_TEST_GATE_REJECTED'},{status:403,headers:{'Cache-Control':'no-store'}});}
    const evmAddress = await mainnetCustodyAddress(wallet);
    return Response.json(
      { assigned: true, chainId: 56, evmAddress },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (error) {
    console.error(JSON.stringify({
      event: 'mainnet_deposit_address_assignment_failed',
      error: error instanceof Error ? error.message : 'UnknownError',
    }));
    return Response.json({ error: 'Unable to assign a controlled mainnet deposit address' }, { status: 503 });
  }
}
