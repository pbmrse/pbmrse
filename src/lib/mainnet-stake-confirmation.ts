import { getCloudflareContext } from '@opennextjs/cloudflare';
import { getAddress, keccak256, toBytes, type Address, type Hash } from 'viem';
import { BUSINESS } from '@/config/business';
import { freshPosition, settleStaking, stake, type Position } from './business-engine';
import { serverDB, type Database } from './server-db';
import { verifyMainnetStakePayment } from './mainnet-stake-payment-proof';
import {mainnetReceiptClient} from './mainnet-reward-config';
import { assertMainnetConfirmedIntentAccess } from './mainnet-stake-test-gate';
import { enqueueCreditedCustodyStake, recordCustodyReceipt } from './mainnet-custody-storage';
import { minimumPlatformGasTopup } from './mainnet-custody-policy';

type StakeIntent = {
  intent_id:string; wallet_address:string; custody_address:string; amount_atomic:string;
  principal_atomic:string|null; referral_wallet:string|null; referral_pgr_atomic:string|null;
  payment_tx_hash:string|null; created_at:number; status:string;
};

export function normalizeMainnetStakeConfirmation(intentId: unknown, paymentHash: unknown) {
  if (typeof intentId !== 'string' || !/^stake:0x[0-9a-fA-F]{40}:[a-zA-Z0-9_-]{8,100}$/.test(intentId) ||
      typeof paymentHash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(paymentHash)) throw new Error('INVALID_STAKE_CONFIRMATION');
  const normalized = { chainId:56, action:'CONFIRM', intentId:intentId.toLowerCase(), paymentHash:paymentHash.toLowerCase() } as const;
  return { ...normalized, purpose:`mainnet-stake-confirm:${keccak256(toBytes(JSON.stringify(normalized)))}` };
}

async function assertCreditedStake(db: Database, intent: StakeIntent, wallet: Address, paymentHash: Hash) {
  const [credit, operation, reward, deposit] = await Promise.all([
    db.prepare(`SELECT principal_atomic,referrer_wallet,referral_pgr_atomic,payment_tx_hash,principal_source_key,referral_source_key
      FROM mainnet_stake_credits WHERE intent_id=? AND lower(wallet_address)=lower(?)`)
      .bind(intent.intent_id, wallet).first<{
        principal_atomic:string; referrer_wallet:string|null; referral_pgr_atomic:string;
        payment_tx_hash:string; principal_source_key:string; referral_source_key:string|null;
      }>(),
    db.prepare(`SELECT operation_id FROM business_operations WHERE operation_id=? AND lower(wallet_address)=lower(?)
      AND chain_id=56 AND operation_type='STAKE' AND amount_atomic=? AND asset='USDT' AND status='CONFIRMED'
      AND lower(tx_hash)=lower(?)`).bind(intent.intent_id, wallet, intent.amount_atomic, paymentHash).first<{operation_id:string}>(),
    intent.referral_wallet ? db.prepare(`SELECT source_key FROM wallet_ledger WHERE source_key=? AND lower(wallet_address)=lower(?)
      AND chain_id=56 AND asset='PGR' AND amount_atomic=? AND entry_type='STAKE_DIRECT_PGR'`)
      .bind(`mainnet-stake-direct-pgr:${intent.intent_id}`, intent.referral_wallet, intent.referral_pgr_atomic).first<{source_key:string}>() : Promise.resolve(null),
    db.prepare(`SELECT amount_atomic,deposit_address FROM bank_deposits WHERE lower(wallet_address)=lower(?) AND chain_id=56 AND lower(tx_hash)=lower(?)`)
      .bind(wallet,paymentHash).first<{amount_atomic:string;deposit_address:string}>(),
  ]);
  if (!credit || !operation || !deposit || deposit.amount_atomic!==intent.amount_atomic||deposit.deposit_address.toLowerCase()!==intent.custody_address.toLowerCase()||credit.payment_tx_hash.toLowerCase() !== paymentHash.toLowerCase() ||
      credit.principal_atomic !== intent.amount_atomic || credit.principal_source_key !== `mainnet-stake-principal:${intent.intent_id}` ||
      (intent.referral_wallet ? !reward || credit.referrer_wallet?.toLowerCase() !== intent.referral_wallet.toLowerCase() ||
        credit.referral_pgr_atomic !== intent.referral_pgr_atomic || credit.referral_source_key !== `mainnet-stake-direct-pgr:${intent.intent_id}` :
        credit.referrer_wallet !== null || credit.referral_pgr_atomic !== '0' || credit.referral_source_key !== null)) {
    throw new Error('CONFIRMED_STAKE_ACCOUNTING_REQUIRES_RECONCILIATION');
  }
}

async function resolveReferrer(db: Database, wallet: Address, requested: string | null) {
  const current = await db.prepare('SELECT parent_wallet FROM wallet_referrals WHERE lower(wallet_address)=lower(?)')
    .bind(wallet).first<{parent_wallet:string|null}>();
  if (current?.parent_wallet) {
    if (requested && current.parent_wallet.toLowerCase() !== requested.toLowerCase()) throw new Error('CONFIRMED_REFERRER_CANNOT_CHANGE');
    return { parent:current.parent_wallet.toLowerCase() as Address, bindingNeeded:false };
  }
  if (!requested) return { parent:null, bindingNeeded:!current };
  const parent = getAddress(requested).toLowerCase() as Address;
  if (parent === wallet.toLowerCase()) throw new Error('SELF_REFERRAL_NOT_ALLOWED');
  const [directs, cycle] = await Promise.all([
    db.prepare('SELECT COUNT(*) count FROM wallet_referrals WHERE lower(parent_wallet)=lower(?)').bind(parent).first<{count:number}>(),
    db.prepare(`WITH RECURSIVE ancestors(wallet) AS (
      SELECT ? UNION ALL SELECT r.parent_wallet FROM wallet_referrals r JOIN ancestors a
      ON lower(r.wallet_address)=lower(a.wallet) WHERE r.parent_wallet IS NOT NULL
    ) SELECT wallet FROM ancestors WHERE lower(wallet)=lower(?) LIMIT 1`).bind(parent, wallet).first<{wallet:string}>(),
  ]);
  if ((directs?.count ?? 0) >= BUSINESS.referralDirectLimit) throw new Error('REFERRAL_DIRECT_LIMIT_REACHED');
  if (cycle) throw new Error('REFERRAL_CYCLE_REJECTED');
  return { parent, bindingNeeded:true };
}

/** Verifies and atomically credits one Chain-56 stake payment exactly once. */
export async function confirmMainnetStakePayment(
  wallet: Address, action: ReturnType<typeof normalizeMainnetStakeConfirmation>,
) {
  return confirmMainnetStakePaymentInternal(wallet,action,false);
}

/** Internal recovery path: it may credit an already-paid, proven intent while
 * new user operations are closed, but only while the dedicated scanner gate is enabled. */
export async function recoverMainnetStakePayment(
  wallet:Address,action:ReturnType<typeof normalizeMainnetStakeConfirmation>,
){return confirmMainnetStakePaymentInternal(wallet,action,true);}

async function confirmMainnetStakePaymentInternal(wallet:Address,action:ReturnType<typeof normalizeMainnetStakeConfirmation>,recovery:boolean){
  const env=getCloudflareContext().env;
  const normal=Reflect.get(env,'MAINNET_BANK_ENABLED')==='true'&&Reflect.get(env,'MAINNET_STAKING_LIFECYCLE_READY')==='true';
  const recoveryAllowed=Reflect.get(env,'MAINNET_CUSTODY_SCAN_ENABLED')==='true'&&Reflect.get(env,'MAINNET_CUSTODY_COLLECTION_READY')==='true';
  if (Reflect.get(env, 'APP_NETWORK') !== 'bsc-mainnet' || (recovery?!recoveryAllowed:!normal)) {
    throw new Error('MAINNET_STAKING_DISABLED');
  }
  if (!action.intentId.startsWith('stake:' + wallet.toLowerCase() + ':')) throw new Error('INVALID_STAKE_INTENT');
  const paymentHash = action.paymentHash as Hash;
  const db = serverDB();
  let intent = await db.prepare(`SELECT intent_id,wallet_address,custody_address,amount_atomic,principal_atomic,referral_wallet,
    referral_pgr_atomic,payment_tx_hash,created_at,status FROM mainnet_stake_intents
    WHERE intent_id=? AND chain_id=56 AND lower(wallet_address)=lower(?)`)
    .bind(action.intentId, wallet).first<StakeIntent>();
  if (!intent) throw new Error('STAKE_INTENT_NOT_FOUND');
  assertMainnetConfirmedIntentAccess(env as Record<string,unknown>,wallet,intent);
  if (!/^[1-9][0-9]{0,77}$/.test(intent.amount_atomic) || BigInt(intent.amount_atomic) > (1n << 256n) - 1n) throw new Error('INVALID_STAKE_AMOUNT');
  const treasuryValue=Reflect.get(env,'MAINNET_TREASURY_ADDRESS');
  if(typeof treasuryValue!=='string'||!/^0x[0-9a-fA-F]{40}$/.test(treasuryValue)||/^0x0{40}$/i.test(treasuryValue))throw new Error('MAINNET_TREASURY_CONFIG_INVALID');
  const treasury=getAddress(treasuryValue),receiptClient=mainnetReceiptClient().client;
  if(intent.custody_address.toLowerCase()!==treasury.toLowerCase()){
    // Historical prepared intents remain verifiable, but no new child custody
    // address can be created by the public Worker.
    const custody=await db.prepare('SELECT deposit_address FROM wallet_custody_addresses WHERE chain_id=56 AND lower(wallet_address)=lower(?)').bind(wallet).first<{deposit_address:string}>();
    if(!custody||custody.deposit_address.toLowerCase()!==intent.custody_address.toLowerCase())throw new Error('STAKE_PAYMENT_RECIPIENT_MISMATCH');
  }

  const proof = await verifyMainnetStakePayment({
    hash:paymentHash, wallet:getAddress(wallet), custody:getAddress(intent.custody_address), minimumAtomic:BigInt(intent.amount_atomic),
  });
  if (proof.amountAtomic !== BigInt(intent.amount_atomic)) throw new Error('STAKE_PAYMENT_AMOUNT_MISMATCH');
  if (proof.blockNumber > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('STAKE_PAYMENT_BLOCK_OVERFLOW');
  if (!Number.isSafeInteger(intent.created_at) || intent.created_at <= 0 || proof.blockTimestamp * 1000n + 1000n < BigInt(intent.created_at)) {
    throw new Error('STAKE_PAYMENT_PREDATES_INTENT');
  }
  let custodyQueue:null|{receiptId:string;gasWalletAddress:Address;gasTopupAtomic:string}=null;
  if(intent.custody_address.toLowerCase()!==treasury.toLowerCase()){
    const env=getCloudflareContext().env;
    const gasWallet=Reflect.get(env,'MAINNET_CUSTODY_GAS_ADDRESS');
    const collectionAddress=Reflect.get(env,'MAINNET_CUSTODY_COLLECTION_ADDRESS');
    const gasTopup=Reflect.get(env,'MAINNET_CUSTODY_GAS_TOPUP_WEI');
    const supported=[Reflect.get(env,'MAINNET_PGR_ADDRESS'),Reflect.get(env,'MAINNET_SOV_ADDRESS')]
      .filter((address):address is Address=>typeof address==='string'&&/^0x[0-9a-fA-F]{40}$/.test(address));
    if(typeof gasWallet!=='string'||!/^0x[0-9a-fA-F]{40}$/.test(gasWallet)||/^0x0{40}$/i.test(gasWallet)||
      typeof collectionAddress!=='string'||!/^0x[0-9a-fA-F]{40}$/.test(collectionAddress)||/^0x0{40}$/i.test(collectionAddress)||
      typeof gasTopup!=='string'||!/^[1-9][0-9]{0,77}$/.test(gasTopup))throw new Error('CUSTODY_GAS_CONFIG_INVALID');
    const gasRows=await db.prepare('SELECT kind,amount_atomic FROM custody_gas_ledger WHERE custody_address=?').bind(intent.custody_address).all<{kind:string;amount_atomic:string}>();
    const total=(kind:string)=>gasRows.results.filter(row=>row.kind===kind).reduce((sum,row)=>sum+BigInt(row.amount_atomic),0n);
    const gasPlan=minimumPlatformGasTopup({gasPriceAtomic:await receiptClient.getGasPrice(),collectionGasLimit:100000n,returnGasLimit:21000n,
      platformTopupAtomic:total('PLATFORM_TOPUP'),gasSpentAtomic:total('CHAIN_GAS_SPENT'),platformReturnedAtomic:total('PLATFORM_GAS_RETURN'),maximumTopupAtomic:BigInt(gasTopup)});
    const receipt=await recordCustodyReceipt(db,{
      ownerWallet:getAddress(wallet),custodyAddress:getAddress(intent.custody_address),sourceWallet:getAddress(proof.wallet),
      native:false,tokenAddress:getAddress('0x55d398326f99059ff775485246999027b3197955'),assetSymbol:'USDT',
      amountAtomic:proof.amountAtomic.toString(),depositTxHash:paymentHash,logIndex:proof.logIndex,
      blockNumber:Number(proof.blockNumber),blockHash:proof.blockHash,stakeIntentId:intent.intent_id,collectionAddress:getAddress(collectionAddress),
      gasWalletAddress:getAddress(gasWallet),gasTopupAtomic:gasPlan.topupAtomic.toString(),supportedTokenAddresses:supported,
    });
    custodyQueue={receiptId:receipt.receiptId,gasWalletAddress:getAddress(gasWallet),gasTopupAtomic:gasPlan.topupAtomic.toString()};
  }
  const minimumCollection=Reflect.get(env,'MAINNET_CUSTODY_MIN_COLLECTION_ATOMIC');
  const collectionAddress=Reflect.get(env,'MAINNET_CUSTODY_COLLECTION_ADDRESS');
  const enqueueCustody=async()=>custodyQueue?enqueueCreditedCustodyStake(db,{...custodyQueue,collectionAddress:getAddress(collectionAddress as string),
    minimumCollectionAtomic:typeof minimumCollection==='string'?minimumCollection:undefined}):null;
  if (intent.status === 'CONFIRMED') {
    if (intent.payment_tx_hash?.toLowerCase() !== paymentHash.toLowerCase() || intent.principal_atomic !== intent.amount_atomic ||
        intent.referral_pgr_atomic === null) throw new Error('STAKE_PAYMENT_REPLAY_CONFLICT');
    await assertCreditedStake(db, intent, wallet, paymentHash);
    await enqueueCustody();
    return { intentId:intent.intent_id, status:'CONFIRMED' as const, alreadyConfirmed:true,
      principalAtomic:intent.principal_atomic, referralWallet:intent.referral_wallet, referralPgrAtomic:intent.referral_pgr_atomic };
  }
  if (intent.status !== 'PREPARED' || intent.payment_tx_hash) throw new Error('STAKE_INTENT_NOT_PREPARED');

  const now = Date.now();
  const referral = await resolveReferrer(db, wallet, intent.referral_wallet);
  const storedWallet = wallet.toLowerCase() as Address;
  const existingPosition = await db.prepare(`SELECT position_json,version FROM business_positions
    WHERE lower(wallet_address)=lower(?) AND chain_id=56 ORDER BY version DESC,updated_at DESC LIMIT 1`)
    .bind(wallet).first<{position_json:string;version:number}>();
  let position: Position;
  try {
    position = existingPosition ? settleStaking(JSON.parse(existingPosition.position_json) as Position, now, BUSINESS.stakingDailyRateBps) : freshPosition(now);
  } catch { throw new Error('MAINNET_STAKE_POSITION_INVALID'); }
  const credited = stake(position, proof.amountAtomic, referral.parent !== null);
  const principalSource = `mainnet-stake-principal:${intent.intent_id}`;
  const rewardSource = referral.parent ? `mainnet-stake-direct-pgr:${intent.intent_id}` : null;
  const details = JSON.stringify({ paymentTxHash:paymentHash.toLowerCase(), custodyAddress:intent.custody_address,
    principalAtomic:credited.principal.toString(), referralWallet:referral.parent, referralPgrAtomic:credited.commission.toString() });
  const referralWrite = referral.parent ?
    (referral.bindingNeeded ? db.prepare(`INSERT INTO wallet_referrals(wallet_address,parent_wallet,confirmed_at)
      SELECT ?,?,? WHERE (SELECT COUNT(*) FROM wallet_referrals WHERE lower(parent_wallet)=lower(?))<?
      AND NOT EXISTS(WITH RECURSIVE ancestors(wallet) AS (
        SELECT ? UNION ALL SELECT r.parent_wallet FROM wallet_referrals r JOIN ancestors a
        ON lower(r.wallet_address)=lower(a.wallet) WHERE r.parent_wallet IS NOT NULL
      ) SELECT 1 FROM ancestors WHERE lower(wallet)=lower(?))
      ON CONFLICT(wallet_address) DO UPDATE SET parent_wallet=excluded.parent_wallet,confirmed_at=excluded.confirmed_at
      WHERE wallet_referrals.parent_wallet IS NULL OR lower(wallet_referrals.parent_wallet)=lower(excluded.parent_wallet)`)
      .bind(storedWallet, referral.parent, now, referral.parent, BUSINESS.referralDirectLimit, referral.parent, storedWallet) :
      db.prepare(`INSERT INTO wallet_referrals(wallet_address,parent_wallet,confirmed_at) VALUES (?,?,?)
        ON CONFLICT(wallet_address) DO UPDATE SET confirmed_at=wallet_referrals.confirmed_at
        WHERE lower(wallet_referrals.parent_wallet)=lower(excluded.parent_wallet)`).bind(storedWallet, referral.parent, now)) :
    db.prepare(`INSERT INTO wallet_referrals(wallet_address,parent_wallet,confirmed_at) VALUES (?,NULL,?)
      ON CONFLICT(wallet_address) DO UPDATE SET confirmed_at=wallet_referrals.confirmed_at
      WHERE wallet_referrals.parent_wallet IS NULL`).bind(storedWallet, now);

  let writes: Awaited<ReturnType<Database['batch']>>;
  try { writes = await db.batch([
    db.prepare(`INSERT INTO business_positions(wallet_address,chain_id,version,position_json,updated_at)
      SELECT ?,56,0,?,? WHERE NOT EXISTS(SELECT 1 FROM business_positions WHERE chain_id=56 AND lower(wallet_address)=lower(?))`)
      .bind(storedWallet, JSON.stringify(freshPosition(now)), now, storedWallet),
    referralWrite,
    db.prepare(`UPDATE business_positions SET position_json=?,version=version+1,updated_at=?,last_operation_id=?
      WHERE lower(wallet_address)=lower(?) AND chain_id=56 AND version=?
      AND NOT EXISTS(SELECT 1 FROM mainnet_stake_credits WHERE intent_id=?)
      AND EXISTS(SELECT 1 FROM wallet_referrals WHERE lower(wallet_address)=lower(?)
        AND COALESCE(lower(parent_wallet),'')=?)`)
      .bind(JSON.stringify(credited.position), now, intent.intent_id, storedWallet, existingPosition?.version ?? 0,
        intent.intent_id, storedWallet, referral.parent?.toLowerCase() ?? ''),
    db.prepare(`INSERT INTO mainnet_stake_credits
      (intent_id,payment_tx_hash,wallet_address,principal_atomic,referrer_wallet,referral_pgr_atomic,principal_source_key,referral_source_key,credited_at)
      SELECT ?,?,?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM business_positions
        WHERE lower(wallet_address)=lower(?) AND chain_id=56 AND last_operation_id=?)`)
      .bind(intent.intent_id, paymentHash.toLowerCase(), storedWallet, credited.principal.toString(), referral.parent,
        credited.commission.toString(), principalSource, rewardSource, now, storedWallet, intent.intent_id),
    db.prepare(`INSERT INTO business_operations
      (operation_id,wallet_address,chain_id,operation_type,amount_atomic,asset,status,created_at,tx_hash,details_json)
      SELECT intent_id,wallet_address,56,'STAKE',principal_atomic,'USDT','CONFIRMED',credited_at,payment_tx_hash,?
      FROM mainnet_stake_credits WHERE intent_id=? ON CONFLICT(operation_id) DO NOTHING`).bind(details, intent.intent_id),
    referral.parent ? db.prepare(`INSERT INTO wallet_ledger
      (wallet_address,chain_id,asset,amount_atomic,entry_type,source_key,created_at)
      SELECT referrer_wallet,56,'PGR',referral_pgr_atomic,'STAKE_DIRECT_PGR',referral_source_key,credited_at
      FROM mainnet_stake_credits WHERE intent_id=? AND referrer_wallet=? AND referral_pgr_atomic=?
      ON CONFLICT(source_key) DO NOTHING`).bind(intent.intent_id, referral.parent, credited.commission.toString()) :
      db.prepare('SELECT 1 WHERE 0'),
    db.prepare(`INSERT INTO bank_deposits(wallet_address,chain_id,tx_hash,deposit_address,amount_atomic,block_number,confirmed_at)
      SELECT wallet_address,56,payment_tx_hash,?,principal_atomic,?,credited_at FROM mainnet_stake_credits WHERE intent_id=?
      ON CONFLICT(wallet_address,chain_id,tx_hash) DO NOTHING`).bind(intent.custody_address,Number(proof.blockNumber),intent.intent_id),
    db.prepare(`UPDATE mainnet_stake_intents SET principal_atomic=?,referral_wallet=?,referral_pgr_atomic=?,payment_tx_hash=?,
      payment_block=?,confirmed_at=?,status='CONFIRMED'
      WHERE intent_id=? AND chain_id=56 AND lower(wallet_address)=lower(?) AND status='PREPARED' AND payment_tx_hash IS NULL
      AND EXISTS(SELECT 1 FROM mainnet_stake_credits WHERE intent_id=? AND lower(payment_tx_hash)=lower(?)
        AND principal_atomic=? AND COALESCE(lower(referrer_wallet),'')=? AND referral_pgr_atomic=?)
      AND EXISTS(SELECT 1 FROM business_operations WHERE operation_id=? AND status='CONFIRMED'
        AND lower(tx_hash)=lower(?) AND amount_atomic=?)
      AND (?='' OR EXISTS(SELECT 1 FROM wallet_ledger WHERE source_key=? AND lower(wallet_address)=? AND amount_atomic=? AND asset='PGR'))`)
      .bind(credited.principal.toString(), referral.parent, credited.commission.toString(), paymentHash.toLowerCase(), Number(proof.blockNumber), now,
        intent.intent_id, wallet, intent.intent_id, paymentHash.toLowerCase(), credited.principal.toString(), referral.parent?.toLowerCase() ?? '',
        credited.commission.toString(), intent.intent_id, paymentHash.toLowerCase(), credited.principal.toString(),
        referral.parent?.toLowerCase() ?? '', rewardSource, referral.parent?.toLowerCase() ?? '', credited.commission.toString()),
  ]); } catch {
    intent = await db.prepare(`SELECT intent_id,wallet_address,custody_address,amount_atomic,principal_atomic,referral_wallet,
      referral_pgr_atomic,payment_tx_hash,created_at,status FROM mainnet_stake_intents WHERE intent_id=? AND chain_id=56`)
      .bind(action.intentId).first<StakeIntent>();
    if (intent?.status === 'CONFIRMED' && intent.payment_tx_hash?.toLowerCase() === paymentHash.toLowerCase()) {
      await assertCreditedStake(db, intent, wallet, paymentHash);
      await enqueueCustody();
      return { intentId:intent.intent_id, status:'CONFIRMED' as const, alreadyConfirmed:true,
        principalAtomic:intent.principal_atomic!, referralWallet:intent.referral_wallet, referralPgrAtomic:intent.referral_pgr_atomic! };
    }
    throw new Error('STAKE_ACCOUNTING_CONFLICT_RECONCILIATION_REQUIRED');
  }
  const expectedRewardChanges = referral.parent ? 1 : 0;
  if (writes.length !== 8 || ![0,1].includes(writes[0].meta.changes) || writes[1].meta.changes !== 1 ||
      writes[2].meta.changes !== 1 || writes[3].meta.changes !== 1 || writes[4].meta.changes !== 1 ||
      writes[5].meta.changes !== expectedRewardChanges || writes[6].meta.changes !== 1 || writes[7].meta.changes !== 1) {
    intent = await db.prepare(`SELECT intent_id,wallet_address,custody_address,amount_atomic,principal_atomic,referral_wallet,
      referral_pgr_atomic,payment_tx_hash,created_at,status FROM mainnet_stake_intents WHERE intent_id=? AND chain_id=56`)
      .bind(action.intentId).first<StakeIntent>();
    if (intent?.status === 'CONFIRMED' && intent.payment_tx_hash?.toLowerCase() === paymentHash.toLowerCase()) {
      await assertCreditedStake(db, intent, wallet, paymentHash);
      await enqueueCustody();
      return { intentId:intent.intent_id, status:'CONFIRMED' as const, alreadyConfirmed:true,
        principalAtomic:intent.principal_atomic!, referralWallet:intent.referral_wallet, referralPgrAtomic:intent.referral_pgr_atomic! };
    }
    throw new Error('STAKE_ACCOUNTING_CONFLICT_RECONCILIATION_REQUIRED');
  }
  intent = await db.prepare(`SELECT intent_id,wallet_address,custody_address,amount_atomic,principal_atomic,referral_wallet,
    referral_pgr_atomic,payment_tx_hash,created_at,status FROM mainnet_stake_intents WHERE intent_id=? AND chain_id=56`)
    .bind(action.intentId).first<StakeIntent>();
  if (!intent || intent.status !== 'CONFIRMED' || intent.payment_tx_hash?.toLowerCase() !== paymentHash.toLowerCase()) {
    throw new Error('STAKE_ACCOUNTING_REQUIRES_RECONCILIATION');
  }
  await assertCreditedStake(db, intent, wallet, paymentHash);
  await enqueueCustody();
  return { intentId:intent.intent_id, status:'CONFIRMED' as const, alreadyConfirmed:false,
    principalAtomic:intent.principal_atomic!, referralWallet:intent.referral_wallet, referralPgrAtomic:intent.referral_pgr_atomic! };
}
