import { authenticateWallet, type WalletProof } from '@/lib/wallet-auth';
import { normalizeMainnetStakePreparation, prepareMainnetStake } from '@/lib/mainnet-stake-prepare';
import { confirmMainnetStakePayment, normalizeMainnetStakeConfirmation } from '@/lib/mainnet-stake-confirmation';
import type { Hash } from 'viem';
import { getCloudflareContext } from '@opennextjs/cloudflare';
import { serverDB } from '@/lib/server-db';
import { cancelMainnetStake, getMainnetStakePosition, normalizeMainnetStakeCancellation } from '@/lib/mainnet-stake-cancellation';
import { assertMainnetCancellationTestAccess, assertMainnetStakeRouteAccess, publicMainnetStakingEnabled } from '@/lib/mainnet-stake-test-gate';

type Body = WalletProof & {
  chainId?: number;
  action?: 'PREPARE' | 'CONFIRM' | 'STATUS' | 'POSITION' | 'CANCEL';
  requestId?: string;
  amountAtomic?: string;
  intentId?: string;
  txHash?: Hash;
  referrerWallet?: string | null;
};

/** Mainnet-only stake order endpoint. Requires a one-use wallet signature per action.
 * Feature flag remains disabled until refunds and PGR accounting are accepted.
 */
export async function POST(request: Request) {
  let body: Body;
  try { body = await request.json() as Body; }
  catch { return Response.json({ error: 'INVALID_JSON' }, { status: 400 }); }
  if (body.chainId !== 56 || !['PREPARE', 'CONFIRM', 'STATUS', 'POSITION', 'CANCEL'].includes(body.action ?? '')) {
    return Response.json({ error: 'INVALID_STAKE_ACTION_OR_CHAIN' }, { status: 400 });
  }
  if (Reflect.get(getCloudflareContext().env, 'APP_NETWORK') !== 'bsc-mainnet') return Response.json({error:'MAINNET_NETWORK_REQUIRED'},{status:503});
  // Read-only status remains available for recovery even while new deposits are disabled.
  if (!['STATUS', 'POSITION'].includes(body.action!) &&
      (Reflect.get(getCloudflareContext().env, 'MAINNET_FINANCIAL_MODE') !== 'enabled' ||
       Reflect.get(getCloudflareContext().env, 'MAINNET_STAKING_LIFECYCLE_READY') !== 'true')) {
    return Response.json({ error: 'MAINNET_STAKING_NOT_READY' }, { status: 503 });
  }
  if (body.action === 'STATUS' && (!body.intentId || !/^stake:0x[0-9a-f]{40}:[a-zA-Z0-9_-]{8,100}$/i.test(body.intentId))) return Response.json({error:'INVALID_STAKE_INTENT'},{status:400});
  let cancellation: ReturnType<typeof normalizeMainnetStakeCancellation> | null = null;
  let preparation: ReturnType<typeof normalizeMainnetStakePreparation> | null = null;
  let confirmation: ReturnType<typeof normalizeMainnetStakeConfirmation> | null = null;
  if (body.action === 'PREPARE') {
    try { preparation = normalizeMainnetStakePreparation(body.requestId, body.amountAtomic, body.referrerWallet); }
    catch { return Response.json({error:'INVALID_STAKE_PREPARATION'},{status:400}); }
  }
  if (body.action === 'CONFIRM') {
    try { confirmation = normalizeMainnetStakeConfirmation(body.intentId, body.txHash); }
    catch { return Response.json({error:'INVALID_STAKE_CONFIRMATION'},{status:400}); }
  }
  if (body.action === 'CANCEL') {
    try { cancellation = normalizeMainnetStakeCancellation(body.requestId, body.amountAtomic); }
    catch { return Response.json({error:'INVALID_STAKE_CANCELLATION'},{status:400}); }
  }
  let wallet;
  try { wallet = await authenticateWallet(body, cancellation?.purpose ?? preparation?.purpose ?? confirmation?.purpose ?? ('mainnet-stake-' + body.action!.toLowerCase())); }
  catch { return Response.json({ error: 'WALLET_AUTH_FAILED' }, { status: 401 }); }
  try {
    if (body.action === 'POSITION') return Response.json(await getMainnetStakePosition(wallet), { headers: { 'Cache-Control': 'no-store' } });
    if (body.action === 'STATUS') {
      if (!body.intentId || !/^stake:0x[0-9a-f]{40}:[a-zA-Z0-9_-]{8,100}$/i.test(body.intentId) || !body.intentId.toLowerCase().startsWith('stake:' + wallet.toLowerCase() + ':')) return Response.json({error:'INVALID_STAKE_INTENT'},{status:400});
      const record = await serverDB().prepare('SELECT intent_id,status,amount_atomic,payment_tx_hash,created_at,confirmed_at FROM mainnet_stake_intents WHERE intent_id=? AND chain_id=56 AND lower(wallet_address)=lower(?)').bind(body.intentId,wallet).first<{intent_id:string;status:string;amount_atomic:string;payment_tx_hash:string|null;created_at:number;confirmed_at:number|null}>();
      return Response.json(record ? {intentId:record.intent_id,status:record.status,amountAtomic:record.amount_atomic,paymentTxHash:record.payment_tx_hash,createdAt:record.created_at,confirmedAt:record.confirmed_at} : {error:'STAKE_INTENT_NOT_FOUND'}, {status:record?200:404,headers:{'Cache-Control':'no-store'}});
    }
    const gateEnv=getCloudflareContext().env as Record<string,unknown>;
    assertMainnetStakeRouteAccess(gateEnv,wallet,body.action as 'PREPARE'|'CONFIRM'|'CANCEL');
    if(body.action==='CANCEL'&&!publicMainnetStakingEnabled(gateEnv))assertMainnetCancellationTestAccess(gateEnv,wallet,cancellation!.amountAtomic);
    const result = body.action === 'PREPARE'
      ? await prepareMainnetStake(wallet, preparation!)
      : body.action === 'CANCEL'
        ? await cancelMainnetStake(wallet, cancellation!)
        : await confirmMainnetStakePayment(wallet, confirmation!);
    return Response.json(result, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'MAINNET_STAKE_UNAVAILABLE';
    console.error(JSON.stringify({ event: 'mainnet_stake_operation_failed', message }));
    const publicCode = /^(MAINNET_(STAKING|STAKE|TREASURY)|STAKE_)[A-Z0-9_]+$/.test(message)
      ? message : 'MAINNET_STAKE_OPERATION_FAILED';
    return Response.json({ error: publicCode },
      { status: 503, headers: { 'Cache-Control': 'no-store' } });
  }
}
