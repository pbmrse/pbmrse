import { getAddress, isAddress, type Address, type Hash } from 'viem';
import type { Database } from './server-db';
import { classifyCustodyReceipt, type CustodyAssetKind } from './mainnet-custody-policy';
import { reconcileCustodyGas } from './mainnet-custody-policy';

const UINT256_MAX = (1n << 256n) - 1n;

export type CustodyReceiptInput = {
  ownerWallet: Address;
  custodyAddress: Address;
  sourceWallet: Address;
  native: boolean;
  tokenAddress: Address | null;
  assetSymbol: string;
  amountAtomic: string;
  depositTxHash: Hash;
  logIndex: number;
  blockNumber: number;
  blockHash: Hash;
  stakeIntentId: string | null;
  collectionAddress: Address;
  gasWalletAddress: Address;
  gasTopupAtomic: string;
  supportedTokenAddresses: readonly Address[];
  now?: number;
};

function positiveAtomic(value: string) {
  return /^[1-9][0-9]{0,77}$/.test(value) && BigInt(value) <= UINT256_MAX;
}

function receiptId(hash: Hash, logIndex: number) {
  return `custody-receipt:${hash.toLowerCase()}:${logIndex}`;
}

function collectionPurpose(kind: CustodyAssetKind) {
  if (kind === 'STAKE_USDT') return 'USDT_TO_TREASURY';
  if (kind === 'MISTAKEN_BNB') return 'MISTAKEN_BNB_TO_RECOVERY';
  if (kind === 'MISTAKEN_SUPPORTED_TOKEN') return 'MISTAKEN_TOKEN_TO_RECOVERY';
  return null;
}

/** Records a verified chain receipt. Stake collection is deliberately deferred until accounting succeeds. */
export async function recordCustodyReceipt(db: Database, input: CustodyReceiptInput) {
  if (!isAddress(input.ownerWallet) || !isAddress(input.custodyAddress) || !isAddress(input.sourceWallet) ||
      !isAddress(input.collectionAddress) || !isAddress(input.gasWalletAddress) ||
      !positiveAtomic(input.amountAtomic) || !/^(0|[1-9][0-9]{0,77})$/.test(input.gasTopupAtomic) || BigInt(input.gasTopupAtomic)>UINT256_MAX ||
      !Number.isSafeInteger(input.logIndex) || input.logIndex < -1 ||
      !Number.isSafeInteger(input.blockNumber) || input.blockNumber < 0 ||
      !/^0x[0-9a-fA-F]{64}$/.test(input.blockHash) ||
      !/^[A-Z0-9]{2,12}$/.test(input.assetSymbol)) throw new Error('CUSTODY_RECEIPT_INVALID');
  const mapping = await db.prepare(`SELECT deposit_address FROM wallet_custody_addresses
    WHERE chain_id=56 AND lower(wallet_address)=lower(?)`).bind(input.ownerWallet).first<{deposit_address:string}>();
  if (!mapping || mapping.deposit_address.toLowerCase() !== input.custodyAddress.toLowerCase()) {
    throw new Error('CUSTODY_OWNER_ADDRESS_MISMATCH');
  }
  if (input.stakeIntentId) {
    const intent = await db.prepare(`SELECT wallet_address,custody_address,amount_atomic,status,payment_tx_hash FROM mainnet_stake_intents
      WHERE intent_id=? AND chain_id=56`).bind(input.stakeIntentId).first<{
        wallet_address:string;custody_address:string;amount_atomic:string;status:string;payment_tx_hash:string|null;
      }>();
    if (!intent || intent.wallet_address.toLowerCase() !== input.ownerWallet.toLowerCase() ||
        intent.custody_address.toLowerCase() !== input.custodyAddress.toLowerCase() ||
        intent.amount_atomic !== input.amountAtomic || !['PREPARED','CONFIRMED'].includes(intent.status) ||
        (intent.status==='CONFIRMED'&&intent.payment_tx_hash?.toLowerCase()!==input.depositTxHash.toLowerCase())) {
      throw new Error('CUSTODY_STAKE_INTENT_MISMATCH');
    }
  }
  const classification = classifyCustodyReceipt({
    native:input.native,tokenAddress:input.tokenAddress,sourceWallet:input.sourceWallet,
    gasWalletAddress:input.gasWalletAddress,collectionAddress:input.collectionAddress,
    matchedStakeIntent:input.stakeIntentId !== null,supportedTokenAddresses:input.supportedTokenAddresses,
  });
  const id = receiptId(input.depositTxHash, input.logIndex);
  const now = input.now ?? Date.now();
  const deferredStake=classification.kind==='STAKE_USDT';
  const needsTopup=!deferredStake&&classification.automaticCollection&&BigInt(input.gasTopupAtomic)>0n;
  const initialStatus = classification.kind === 'UNSUPPORTED_TOKEN' ? 'MANUAL_REVIEW' :
    classification.kind === 'PLATFORM_GAS'||deferredStake ? 'DETECTED' : needsTopup?'GAS_PENDING':'READY_TO_COLLECT';
  const purpose = collectionPurpose(classification.kind);
  const assetJobId = purpose&&!deferredStake ? `custody:${purpose.toLowerCase()}:${id}` : null;
  const topupJobId = purpose&&!deferredStake&&needsTopup ? `custody:gas-topup:${id}` : null;
  const receiptToken = input.tokenAddress?.toLowerCase() ?? null;
  const writes = [
    db.prepare(`INSERT INTO custody_asset_receipts
      (receipt_id,owner_wallet,custody_address,source_wallet,chain_id,asset_kind,token_address,asset_symbol,amount_atomic,
       deposit_tx_hash,log_index,block_number,deposit_block_hash,stake_intent_id,status,detected_at)
      VALUES (?,?,?,?,56,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(receipt_id) DO NOTHING`)
      .bind(id,input.ownerWallet.toLowerCase(),input.custodyAddress.toLowerCase(),input.sourceWallet.toLowerCase(),
        classification.kind,receiptToken,input.assetSymbol,input.amountAtomic,input.depositTxHash.toLowerCase(),input.logIndex,
        input.blockNumber,input.blockHash.toLowerCase(),input.stakeIntentId,initialStatus,now),
  ];
  if (classification.kind === 'PLATFORM_GAS' || classification.kind === 'MISTAKEN_BNB') {
    writes.push(db.prepare(`INSERT INTO custody_gas_ledger
      (event_id,owner_wallet,custody_address,kind,amount_atomic,tx_hash,block_number,created_at)
      VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(event_id) DO NOTHING`)
      .bind(`gas:${classification.kind}:${input.depositTxHash.toLowerCase()}`,input.ownerWallet.toLowerCase(),
        input.custodyAddress.toLowerCase(),classification.kind === 'PLATFORM_GAS'?'PLATFORM_TOPUP':'USER_BNB_DEPOSIT',
        input.amountAtomic,input.depositTxHash.toLowerCase(),input.blockNumber,now));
  }
  if (purpose && classification.destination && !deferredStake) {
    if(needsTopup)writes.push(
      db.prepare(`INSERT INTO custody_collection_jobs
        (job_id,receipt_id,owner_wallet,custody_address,purpose,signer_kind,sender_address,recipient_address,chain_id,
         asset,token_address,amount_atomic,status,created_at)
        VALUES (?,?,?,?,?,'GAS_WALLET',?,?,56,'BNB',NULL,?,'PENDING',?) ON CONFLICT(job_id) DO NOTHING`)
        .bind(topupJobId,id,input.ownerWallet.toLowerCase(),input.custodyAddress.toLowerCase(),'GAS_TOPUP',
          input.gasWalletAddress.toLowerCase(),input.custodyAddress.toLowerCase(),input.gasTopupAtomic,now),
    );
    writes.push(db.prepare(`INSERT INTO custody_collection_jobs
        (job_id,receipt_id,owner_wallet,custody_address,purpose,signer_kind,sender_address,recipient_address,chain_id,
         asset,token_address,amount_atomic,status,created_at)
        VALUES (?,?,?,?,?,'CUSTODY',?,?,56,?,?,?,?,?) ON CONFLICT(job_id) DO NOTHING`)
        .bind(assetJobId,id,input.ownerWallet.toLowerCase(),input.custodyAddress.toLowerCase(),purpose,
          input.custodyAddress.toLowerCase(),classification.destination.toLowerCase(),input.native?'BNB':'ERC20',
          receiptToken,input.amountAtomic,needsTopup?'HELD':'PENDING',now));
  }
  await db.batch(writes);
  const saved = await db.prepare(`SELECT receipt_id,owner_wallet,custody_address,source_wallet,asset_kind,token_address,
    amount_atomic,deposit_tx_hash,log_index,block_number,deposit_block_hash,stake_intent_id,status FROM custody_asset_receipts WHERE receipt_id=?`)
    .bind(id).first<Record<string,string|number|null>>();
  if (!saved || saved.owner_wallet !== input.ownerWallet.toLowerCase() || saved.custody_address !== input.custodyAddress.toLowerCase() ||
      saved.source_wallet !== input.sourceWallet.toLowerCase() || saved.asset_kind !== classification.kind ||
      saved.amount_atomic !== input.amountAtomic || String(saved.deposit_tx_hash).toLowerCase() !== input.depositTxHash.toLowerCase() ||
      saved.log_index !== input.logIndex || (saved.stake_intent_id ?? null) !== input.stakeIntentId) {
    throw new Error('CUSTODY_RECEIPT_REPLAY_CONFLICT');
  }
  if(saved.block_number!==input.blockNumber||String(saved.deposit_block_hash).toLowerCase()!==input.blockHash.toLowerCase()){
    throw new Error('CUSTODY_RECEIPT_REORG_CONFLICT');
  }
  if(purpose&&!deferredStake){
    const jobs=await db.prepare(`SELECT purpose,sender_address,recipient_address,amount_atomic,status FROM custody_collection_jobs
      WHERE receipt_id=? ORDER BY purpose`).bind(id).all<{purpose:string;sender_address:string;recipient_address:string;amount_atomic:string;status:string}>();
    if(jobs.results.length!==(needsTopup?2:1)||(needsTopup&&!jobs.results.some(job=>job.purpose==='GAS_TOPUP'&&job.sender_address===input.gasWalletAddress.toLowerCase()&&job.recipient_address===input.custodyAddress.toLowerCase()&&job.amount_atomic===input.gasTopupAtomic))||
      !jobs.results.some(job=>job.purpose===purpose&&job.recipient_address===classification.destination!.toLowerCase()&&job.amount_atomic===input.amountAtomic))throw new Error('CUSTODY_JOB_REPLAY_CONFLICT');
  }
  return {receiptId:id,kind:classification.kind,status:saved.status,creditsStake:classification.creditsStake,
    createsPgr:classification.createsPgr,topupJobId,collectionJobId:assetJobId};
}

/** Creates collection obligations only after principal and PGR accounting are durably present. */
export async function enqueueCreditedCustodyStake(db:Database,input:{receiptId:string;collectionAddress:Address;gasWalletAddress:Address;gasTopupAtomic:string;minimumCollectionAtomic?:string;now?:number}){
  if(!isAddress(input.collectionAddress)||!isAddress(input.gasWalletAddress)||!/^(0|[1-9][0-9]{0,77})$/.test(input.gasTopupAtomic)||BigInt(input.gasTopupAtomic)>UINT256_MAX)throw new Error('CUSTODY_STAKE_QUEUE_INPUT_INVALID');
  const receipt=await db.prepare(`SELECT receipt_id,owner_wallet,custody_address,amount_atomic,deposit_tx_hash,stake_intent_id,status
    FROM custody_asset_receipts WHERE receipt_id=? AND asset_kind='STAKE_USDT'`).bind(input.receiptId).first<{receipt_id:string;owner_wallet:string;custody_address:string;amount_atomic:string;deposit_tx_hash:string;stake_intent_id:string;status:string}>();
  if(!receipt||!['DETECTED','GAS_PENDING','READY_TO_COLLECT','COLLECTING','COLLECTED'].includes(receipt.status))throw new Error('CUSTODY_STAKE_RECEIPT_NOT_ACCOUNTABLE');
  const accounted=await db.prepare(`SELECT i.referral_wallet,i.referral_pgr_atomic,c.principal_atomic,c.referral_source_key
    FROM mainnet_stake_intents i JOIN mainnet_stake_credits c ON c.intent_id=i.intent_id
    JOIN business_operations o ON o.operation_id=i.intent_id
    WHERE i.intent_id=? AND i.status='CONFIRMED' AND lower(i.payment_tx_hash)=lower(?) AND i.principal_atomic=?
      AND lower(c.wallet_address)=lower(?) AND c.principal_atomic=? AND lower(c.payment_tx_hash)=lower(?)
      AND o.status='CONFIRMED' AND o.asset='USDT' AND o.amount_atomic=?
      AND (i.referral_wallet IS NULL OR EXISTS(SELECT 1 FROM wallet_ledger l WHERE l.source_key=c.referral_source_key
        AND lower(l.wallet_address)=lower(i.referral_wallet) AND l.asset='PGR' AND l.amount_atomic=i.referral_pgr_atomic))`)
    .bind(receipt.stake_intent_id,receipt.deposit_tx_hash,receipt.amount_atomic,receipt.owner_wallet,receipt.amount_atomic,receipt.deposit_tx_hash,receipt.amount_atomic)
    .first<{referral_wallet:string|null;referral_pgr_atomic:string;principal_atomic:string;referral_source_key:string|null}>();
  if(!accounted)throw new Error('CUSTODY_STAKE_ACCOUNTING_INCOMPLETE');
  const minimum=input.minimumCollectionAtomic??'500000000000000000';
  if(!positiveAtomic(minimum)||BigInt(receipt.amount_atomic)<BigInt(minimum))throw new Error('CUSTODY_COLLECTION_MINIMUM_NOT_MET');
  const needsTopup=BigInt(input.gasTopupAtomic)>0n,topupJobId=needsTopup?`custody:gas-topup:${receipt.receipt_id}`:null;
  const collectionJobId=`custody:usdt_to_treasury:${receipt.receipt_id}`,now=input.now??Date.now();
  const writes=[];
  if(needsTopup)writes.push(db.prepare(`INSERT INTO custody_collection_jobs
    (job_id,receipt_id,owner_wallet,custody_address,purpose,signer_kind,sender_address,recipient_address,chain_id,asset,token_address,amount_atomic,status,created_at)
    SELECT ?,receipt_id,owner_wallet,custody_address,'GAS_TOPUP','GAS_WALLET',?,custody_address,56,'BNB',NULL,?,'PENDING',?
    FROM custody_asset_receipts WHERE receipt_id=? AND asset_kind='STAKE_USDT' ON CONFLICT(job_id) DO NOTHING`)
    .bind(topupJobId,input.gasWalletAddress.toLowerCase(),input.gasTopupAtomic,now,receipt.receipt_id));
  writes.push(db.prepare(`INSERT INTO custody_collection_jobs
    (job_id,receipt_id,owner_wallet,custody_address,purpose,signer_kind,sender_address,recipient_address,chain_id,asset,token_address,amount_atomic,status,created_at)
    SELECT ?,receipt_id,owner_wallet,custody_address,'USDT_TO_TREASURY','CUSTODY',custody_address,?,56,'ERC20',token_address,amount_atomic,?,?
    FROM custody_asset_receipts WHERE receipt_id=? AND asset_kind='STAKE_USDT' ON CONFLICT(job_id) DO NOTHING`)
    .bind(collectionJobId,input.collectionAddress.toLowerCase(),needsTopup?'HELD':'PENDING',now,receipt.receipt_id));
  writes.push(db.prepare(`UPDATE custody_asset_receipts SET status=? WHERE receipt_id=? AND status='DETECTED'
    AND EXISTS(SELECT 1 FROM custody_collection_jobs WHERE job_id=?)`).bind(needsTopup?'GAS_PENDING':'READY_TO_COLLECT',receipt.receipt_id,collectionJobId));
  await db.batch(writes);
  // Reconcile only the two primary collection obligations. A completed sweep
  // may later gain one or more PLATFORM_GAS_RETURN jobs; those are separate,
  // idempotent obligations and must not make a historical receipt fail replay.
  const jobs=await db.prepare(`SELECT job_id,purpose,sender_address,recipient_address,amount_atomic,status
    FROM custody_collection_jobs WHERE receipt_id=? AND purpose IN ('GAS_TOPUP','USDT_TO_TREASURY') ORDER BY purpose`)
    .bind(receipt.receipt_id).all<{job_id:string;purpose:string;sender_address:string;recipient_address:string;amount_atomic:string;status:string}>();
  const collectionJob=jobs.results.find(job=>job.job_id===collectionJobId);
  // A previously confirmed sweep is immutable historical evidence and remains
  // idempotently readable after a destination-policy change. Any unsigned,
  // pending or failed legacy destination still fails closed.
  const collectionReconciled=Boolean(collectionJob&&collectionJob.amount_atomic===receipt.amount_atomic&&
    (collectionJob.recipient_address===input.collectionAddress.toLowerCase()||collectionJob.status==='CONFIRMED'));
  if(jobs.results.length!==(needsTopup?2:1)||!collectionReconciled||(needsTopup&&!jobs.results.some(job=>job.job_id===topupJobId&&job.sender_address===input.gasWalletAddress.toLowerCase()&&job.amount_atomic===input.gasTopupAtomic)))throw new Error('CUSTODY_STAKE_QUEUE_RECONCILIATION_REQUIRED');
  return {receiptId:receipt.receipt_id,topupJobId,collectionJobId,status:needsTopup?'GAS_PENDING':'READY_TO_COLLECT'};
}

/** Releases an asset sweep only after the platform-funded gas transfer itself is observed on chain. */
export async function releaseCustodyCollectionAfterGas(db:Database,topupJobId:string,txHash:Hash,now=Date.now()){
  const job=await db.prepare(`SELECT job_id,receipt_id,custody_address,status,tx_hash FROM custody_collection_jobs
    WHERE job_id=? AND purpose='GAS_TOPUP'`).bind(topupJobId).first<{job_id:string;receipt_id:string;custody_address:string;status:string;tx_hash:string|null}>();
  if(!job||!['SENT','CONFIRMED'].includes(job.status)||job.tx_hash?.toLowerCase()!==txHash.toLowerCase())throw new Error('CUSTODY_GAS_JOB_INVALID');
  const deposit=await db.prepare(`SELECT event_id FROM custody_gas_ledger WHERE custody_address=? AND kind='PLATFORM_TOPUP' AND lower(tx_hash)=lower(?)`)
    .bind(job.custody_address,txHash).first<{event_id:string}>();
  if(!deposit)throw new Error('CUSTODY_GAS_TOPUP_NOT_OBSERVED');
  const writes=await db.batch([
    db.prepare(`UPDATE custody_collection_jobs SET status='CONFIRMED',confirmed_at=?,last_error=NULL WHERE job_id=? AND status IN ('SENT','CONFIRMED') AND lower(tx_hash)=lower(?)`).bind(now,job.job_id,txHash),
    db.prepare(`UPDATE custody_daily_reservations SET state='SETTLED',settled_at=?
      WHERE job_id=? AND state='RESERVED'`).bind(now,job.job_id),
    db.prepare(`UPDATE custody_collection_jobs SET status='PENDING' WHERE receipt_id=? AND status='HELD' AND purpose<>'GAS_TOPUP'`).bind(job.receipt_id),
    db.prepare(`UPDATE custody_asset_receipts SET status='READY_TO_COLLECT' WHERE receipt_id=? AND status='GAS_PENDING'`).bind(job.receipt_id),
  ]);
  if(writes.some(result=>result.meta.changes!==1))throw new Error('CUSTODY_GAS_RELEASE_CONFLICT');
}

/** Confirms one exact sweep without mutating already-confirmed stake accounting. */
export async function confirmCustodyCollection(db:Database,input:{jobId:string;txHash:Hash;blockNumber:number;gasSpentAtomic:string;now?:number}){
  if(!Number.isSafeInteger(input.blockNumber)||input.blockNumber<0||!positiveAtomic(input.gasSpentAtomic))throw new Error('CUSTODY_COLLECTION_CONFIRMATION_INVALID');
  const job=await db.prepare(`SELECT job_id,receipt_id,owner_wallet,custody_address,purpose,amount_atomic,status,tx_hash FROM custody_collection_jobs WHERE job_id=?`)
    .bind(input.jobId).first<{job_id:string;receipt_id:string;owner_wallet:string;custody_address:string;purpose:string;amount_atomic:string;status:string;tx_hash:string|null}>();
  const receipt=job?await db.prepare(`SELECT asset_kind,deposit_tx_hash,amount_atomic,status FROM custody_asset_receipts WHERE receipt_id=?`).bind(job.receipt_id)
    .first<{asset_kind:string;deposit_tx_hash:string;amount_atomic:string;status:string}>():null;
  if(!job||!receipt||job.status!=='SENT'||job.tx_hash?.toLowerCase()!==input.txHash.toLowerCase()||job.amount_atomic!==receipt.amount_atomic||
    !['USDT_TO_TREASURY','MISTAKEN_BNB_TO_RECOVERY','MISTAKEN_TOKEN_TO_RECOVERY'].includes(job.purpose))throw new Error('CUSTODY_COLLECTION_JOB_INVALID');
  const now=input.now??Date.now();
  const writes=[
    db.prepare(`UPDATE custody_collection_jobs SET status='CONFIRMED',confirmed_at=?,last_error=NULL WHERE job_id=? AND status='SENT' AND lower(tx_hash)=lower(?)`).bind(now,job.job_id,input.txHash),
    db.prepare(`UPDATE custody_asset_receipts SET status='COLLECTED',collection_tx_hash=?,collected_at=?,last_error=NULL WHERE receipt_id=? AND status IN ('READY_TO_COLLECT','COLLECTING')`).bind(input.txHash.toLowerCase(),now,job.receipt_id),
    db.prepare(`INSERT INTO custody_gas_ledger(event_id,owner_wallet,custody_address,kind,amount_atomic,tx_hash,block_number,related_job_id,created_at)
      VALUES (?,?,?,'CHAIN_GAS_SPENT',?,?,?,?,?) ON CONFLICT(event_id) DO NOTHING`).bind(`gas-spent:${job.job_id}`,job.owner_wallet,job.custody_address,input.gasSpentAtomic,input.txHash.toLowerCase(),input.blockNumber,job.job_id,now),
  ];
  if(job.purpose!=='USDT_TO_TREASURY')writes.push(db.prepare(`UPDATE custody_daily_reservations SET state='SETTLED',settled_at=?
    WHERE job_id=? AND state='RESERVED'`).bind(now,job.job_id));
  if(receipt.asset_kind==='MISTAKEN_BNB')writes.push(db.prepare(`INSERT INTO custody_gas_ledger(event_id,owner_wallet,custody_address,kind,amount_atomic,tx_hash,block_number,related_job_id,created_at)
    VALUES (?,?,?,'USER_BNB_COLLECTION',?,?,?,?,?) ON CONFLICT(event_id) DO NOTHING`).bind(`user-bnb-collected:${job.job_id}`,job.owner_wallet,job.custody_address,receipt.amount_atomic,input.txHash.toLowerCase(),input.blockNumber,job.job_id,now));
  const results=await db.batch(writes);
  if(results.some(result=>result.meta.changes!==1))throw new Error('CUSTODY_COLLECTION_CONFIRMATION_CONFLICT');
}

/** Plans return of platform BNB only after all user-mistaken BNB has left the custody address. */
export async function createPlatformGasReturn(db:Database,input:{receiptId:string;collectionAddress:Address;chainBalanceAtomic:string;returnGasCostAtomic:string;now?:number}){
  if(!isAddress(input.collectionAddress)||/^0x0{40}$/i.test(input.collectionAddress)||!positiveAtomic(input.chainBalanceAtomic)||!positiveAtomic(input.returnGasCostAtomic))throw new Error('CUSTODY_GAS_RETURN_INVALID');
  const receipt=await db.prepare('SELECT owner_wallet,custody_address,status FROM custody_asset_receipts WHERE receipt_id=?').bind(input.receiptId).first<{owner_wallet:string;custody_address:string;status:string}>();
  if(!receipt||receipt.status!=='COLLECTED')throw new Error('CUSTODY_GAS_RETURN_RECEIPT_INVALID');
  const ledger=await db.prepare(`SELECT kind,amount_atomic FROM custody_gas_ledger WHERE custody_address=?`).bind(receipt.custody_address).all<{kind:string;amount_atomic:string}>();
  const total=(kind:string)=>ledger.results.filter(row=>row.kind===kind).reduce((sum,row)=>sum+BigInt(row.amount_atomic),0n);
  const reconciled=reconcileCustodyGas({platformTopupAtomic:total('PLATFORM_TOPUP'),gasSpentAtomic:total('CHAIN_GAS_SPENT'),platformReturnedAtomic:total('PLATFORM_GAS_RETURN'),userBnbDepositedAtomic:total('USER_BNB_DEPOSIT'),userBnbCollectedAtomic:total('USER_BNB_COLLECTION'),chainBalanceAtomic:BigInt(input.chainBalanceAtomic)});
  const fee=BigInt(input.returnGasCostAtomic);if(reconciled.userRemainingAtomic!==0n||reconciled.platformRemainingAtomic<=fee)throw new Error('CUSTODY_GAS_RETURN_NOT_SAFE');
  const prior=await db.prepare(`SELECT COUNT(*) count FROM custody_collection_jobs
    WHERE receipt_id=? AND purpose='PLATFORM_GAS_RETURN'`).bind(input.receiptId).first<{count:number}>();
  const sequence=(prior?.count??0)+1;
  const amount=(reconciled.platformRemainingAtomic-fee).toString(),jobId=`custody:gas-return:${input.receiptId}:${sequence}`;const now=input.now??Date.now();
  const inserted=await db.prepare(`INSERT INTO custody_collection_jobs(job_id,receipt_id,owner_wallet,custody_address,purpose,signer_kind,sender_address,recipient_address,chain_id,asset,token_address,amount_atomic,status,created_at)
    SELECT ?,?,?,?,'PLATFORM_GAS_RETURN','CUSTODY',?,?,56,'BNB',NULL,?,'PENDING',?
    WHERE NOT EXISTS(SELECT 1 FROM custody_collection_jobs active WHERE lower(active.custody_address)=lower(?)
      AND active.purpose='PLATFORM_GAS_RETURN' AND active.status IN ('PENDING','PREPARING','SIGNED','SENT','HELD'))
    ON CONFLICT(job_id) DO NOTHING`).bind(jobId,input.receiptId,receipt.owner_wallet,receipt.custody_address,receipt.custody_address,input.collectionAddress.toLowerCase(),amount,now,receipt.custody_address).run() as {meta?:{changes?:number}};
  if(inserted.meta?.changes!==1){
    const active=await db.prepare("SELECT job_id,amount_atomic FROM custody_collection_jobs WHERE lower(custody_address)=lower(?) AND purpose='PLATFORM_GAS_RETURN' AND status IN ('PENDING','PREPARING','SIGNED','SENT','HELD') ORDER BY created_at LIMIT 1").bind(receipt.custody_address).first<{job_id:string;amount_atomic:string}>();
    if(active)return {jobId:active.job_id,amountAtomic:active.amount_atomic,created:false};
    throw new Error('CUSTODY_GAS_RETURN_INSERT_CONFLICT');
  }
  return {jobId,amountAtomic:amount,created:true};
}

export async function recordManualCustodyRefund(db: Database, input: {
  refundId:string;receiptId:string;originalSender:Address;destinationAddress:Address;assetSymbol:string;
  tokenAddress:Address|null;amountAtomic:string;operator:string;now?:number;
}) {
  if (input.originalSender.toLowerCase() !== input.destinationAddress.toLowerCase() || !positiveAtomic(input.amountAtomic) ||
      !/^[a-zA-Z0-9_.@-]{1,80}$/.test(input.operator)) throw new Error('CUSTODY_MANUAL_REFUND_INVALID');
  const receipt = await db.prepare(`SELECT source_wallet,asset_symbol,token_address,amount_atomic,status
    FROM custody_asset_receipts WHERE receipt_id=? AND asset_kind<>'STAKE_USDT'`).bind(input.receiptId).first<{
      source_wallet:string;asset_symbol:string;token_address:string|null;amount_atomic:string;status:string;
    }>();
  if (!receipt || receipt.source_wallet.toLowerCase() !== input.originalSender.toLowerCase() ||
      receipt.asset_symbol !== input.assetSymbol || (receipt.token_address ?? '').toLowerCase() !== (input.tokenAddress ?? '').toLowerCase() ||
      BigInt(input.amountAtomic) > BigInt(receipt.amount_atomic) || !['COLLECTED','MANUAL_REVIEW','REFUND_RECORDED'].includes(receipt.status)) {
    throw new Error('CUSTODY_MANUAL_REFUND_RECEIPT_MISMATCH');
  }
  const now=input.now??Date.now();
  await db.batch([
    db.prepare(`INSERT INTO custody_manual_refunds
      (refund_id,receipt_id,original_sender,destination_address,asset_symbol,token_address,amount_atomic,status,verified_by,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,'RECORDED',?,?,?) ON CONFLICT(refund_id) DO NOTHING`)
      .bind(input.refundId,input.receiptId,input.originalSender.toLowerCase(),input.destinationAddress.toLowerCase(),
        input.assetSymbol,input.tokenAddress?.toLowerCase()??null,input.amountAtomic,input.operator,now,now),
    db.prepare(`UPDATE custody_asset_receipts SET status='REFUND_RECORDED'
      WHERE receipt_id=? AND status IN ('COLLECTED','MANUAL_REVIEW')`).bind(input.receiptId),
  ]);
  return {recorded:true,automaticPayment:false};
}
