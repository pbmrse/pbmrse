import { getCloudflareContext } from '@opennextjs/cloudflare';
import { getAddress, isAddress, keccak256, toBytes, type Address } from 'viem';
import { mainnetCustodyAddress } from './mainnet-custody-address';
import { serverDB } from './server-db';
import { assertMainnetStakePreparationAccess, assertMainnetStakeTestCustodyAddress, mainnetStakeIntentId, publicMainnetStakingEnabled } from './mainnet-stake-test-gate';

export function normalizeMainnetStakePreparation(requestId: unknown, amountAtomic: unknown, referrerWallet: unknown) {
  if (typeof requestId !== 'string' || !/^[a-zA-Z0-9_-]{8,100}$/.test(requestId) ||
      typeof amountAtomic !== 'string' || !/^[1-9][0-9]{0,77}$/.test(amountAtomic) ||
      BigInt(amountAtomic) > (1n << 256n) - 1n) throw new Error('INVALID_STAKE_REQUEST');
  const referrer = referrerWallet == null || referrerWallet === '' ? null :
    typeof referrerWallet === 'string' && isAddress(referrerWallet) ? getAddress(referrerWallet).toLowerCase() as Address : null;
  if (referrerWallet != null && referrerWallet !== '' && !referrer) throw new Error('INVALID_STAKE_REFERRER');
  const normalized = { chainId:56, action:'PREPARE', requestId, amountAtomic, referrerWallet:referrer } as const;
  return { ...normalized, purpose:`mainnet-stake-prepare:${keccak256(toBytes(JSON.stringify(normalized)))}` };
}

export async function prepareMainnetStake(
  wallet: Address, request: ReturnType<typeof normalizeMainnetStakePreparation>,
) {
  const env = getCloudflareContext().env;
  if (Reflect.get(env, 'APP_NETWORK') !== 'bsc-mainnet' ||
      Reflect.get(env, 'MAINNET_BANK_ENABLED') !== 'true') throw new Error('MAINNET_STAKING_DISABLED');
  const owner = getAddress(wallet);
  assertMainnetStakePreparationAccess(env as Record<string, unknown>, owner, request);
  if (request.referrerWallet?.toLowerCase() === owner.toLowerCase()) throw new Error('SELF_REFERRAL_NOT_ALLOWED');
  const intentId = mainnetStakeIntentId(owner,request.requestId,env as Record<string,unknown>);
  // Resolve the immutable binding; if it does not exist, only the isolated
  // Custody Signer may derive it. The public Worker receives no key material.
  const custodyAddress = await mainnetCustodyAddress(owner);
  // Acceptance is deliberately independent from collection execution. The
  // payment address is nevertheless pinned to the one offline-recovered
  // production mapping; collection stays queued behind its own disabled gate.
  if(!publicMainnetStakingEnabled(env as Record<string,unknown>))assertMainnetStakeTestCustodyAddress(custodyAddress);
  const db = serverDB();
  const existingReferral = await db.prepare('SELECT parent_wallet FROM wallet_referrals WHERE lower(wallet_address)=lower(?)')
    .bind(owner).first<{parent_wallet:string|null}>();
  if (existingReferral?.parent_wallet && request.referrerWallet &&
      existingReferral.parent_wallet.toLowerCase() !== request.referrerWallet.toLowerCase()) {
    throw new Error('CONFIRMED_REFERRER_CANNOT_CHANGE');
  }
  const referrer = (existingReferral?.parent_wallet ?? request.referrerWallet)?.toLowerCase() ?? null;
  await db.prepare(
    "INSERT INTO mainnet_stake_intents(intent_id,wallet_address,chain_id,custody_address,amount_atomic,referral_wallet,status,created_at) VALUES (?,?,56,?,?,?,'PREPARED',?) ON CONFLICT(intent_id) DO NOTHING"
  ).bind(intentId, owner.toLowerCase(), custodyAddress.toLowerCase(), request.amountAtomic, referrer, Date.now()).run();
  const saved = await db.prepare(
    'SELECT wallet_address,custody_address,amount_atomic,referral_wallet,status FROM mainnet_stake_intents WHERE intent_id=? AND chain_id=56'
  ).bind(intentId).first<{wallet_address:string;custody_address:string;amount_atomic:string;referral_wallet:string|null;status:string}>();
  if (!saved || saved.wallet_address.toLowerCase() !== owner.toLowerCase() ||
      saved.custody_address.toLowerCase() !== custodyAddress.toLowerCase() ||
      saved.amount_atomic !== request.amountAtomic || (saved.referral_wallet ?? '').toLowerCase() !== (referrer ?? '').toLowerCase() ||
      saved.status !== 'PREPARED') throw new Error('STAKE_PREPARATION_CONFLICT');
  return { intentId, chainId:56 as const, custodyAddress, amountAtomic:request.amountAtomic, referrerWallet:referrer, status:saved.status };
}
