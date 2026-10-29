import {encodeFunctionData,keccak256,parseAbi,type Address,type Hash,type Hex} from 'viem';
import {serverDB} from './server-db';
import {mainnetBankClients,mainnetBankEnabled} from './mainnet-bank-config';
import {mainnetContracts} from './contracts-mainnet';
import {mainnetStakeRefundEnabled,mainnetStakeRefundLimits} from './mainnet-stake-refund-config';

const ERC20=parseAbi(['function transfer(address to,uint256 amount) returns (bool)','function balanceOf(address) view returns(uint256)','function decimals() view returns(uint8)','event Transfer(address indexed from,address indexed to,uint256 value)']);
type Job={job_id:string;operation_id:string|null;owner_wallet:string;sender_kind:string;sender_address:Address;recipient_address:Address;chain_id:number;asset:string;amount_atomic:string;status:string;last_error:string|null;nonce:number|null;raw_transaction:Hex|null;tx_hash:Hash|null;lease_token:string|null;lease_expires_at:number|null;fencing_token:number;signing_expires_at:number|null;job_fingerprint:Hex|null;treasury_day:string|null};
type RefundObligation={cancellation_id:string;wallet_address:string;amount_atomic:string;fee_atomic:string;refund_atomic:string;status:string;reserved_day:string};
type JobAuthorization={authorization_mode:string;authorization_status:string;risk_code:string;expires_at:number};
const isTerminal=(status:string)=>['CONFIRMED','FAILED','REJECTED','HELD'].includes(status);

/** Mainnet-only treasury USDT sender. Custody payouts intentionally remain disabled. */
export async function processMainnetBankJob(jobId:string){
 if(!mainnetBankEnabled())throw new Error('Mainnet bank operations are disabled');
 const cfg=mainnetBankClients();await cfg.assertChain();
 const db=serverDB();
 let job=await db.prepare('SELECT * FROM bank_transaction_queue WHERE job_id=? AND chain_id=56').bind(jobId).first<Job>();
 if(!job)return {processed:false};
 if(job.status==='CONFIRMED'&&job.last_error==='CONFIRMED_PAYOUT_ROW_MISMATCH_REQUIRES_RECONCILIATION')return {processed:false,reason:'confirmed_payout_requires_reconciliation'};
 if(isTerminal(job.status))return {processed:false};
 if(job.asset!=='USDT'||job.sender_kind!=='TREASURY'||job.sender_address.toLowerCase()!==cfg.address.toLowerCase()||!/^0x[0-9a-f]{40}$/i.test(job.recipient_address)||/^0x0{40}$/i.test(job.recipient_address)||!/^[1-9][0-9]{0,77}$/.test(job.amount_atomic)||BigInt(job.amount_atomic)>(1n<<256n)-1n||!job.job_fingerprint)throw new Error('Unsupported or invalid mainnet payout job');
 const isStakeRefund=job.operation_id?.startsWith('stake-cancel:')===true&&job.job_id===`stake-refund:${job.operation_id}`;
 if(job.owner_wallet.toLowerCase()!==job.recipient_address.toLowerCase())throw new Error('Mainnet payout owner and recipient mismatch');
 if(isStakeRefund){
  if(!mainnetStakeRefundEnabled())throw new Error('Mainnet stake refunds are disabled');
  const limits=mainnetStakeRefundLimits();
  const refund=await db.prepare("SELECT cancellation_id,wallet_address,amount_atomic,fee_atomic,refund_atomic,status,reserved_day FROM mainnet_stake_cancellations WHERE cancellation_id=? AND chain_id=56").bind(job.operation_id).first<RefundObligation>();
  if(!refund||refund.cancellation_id!==job.operation_id||refund.wallet_address.toLowerCase()!==job.recipient_address.toLowerCase()||refund.refund_atomic!==job.amount_atomic||!['READY','PREPARING','SIGNED','SENT'].includes(refund.status))throw new Error('Mainnet stake refund obligation mismatch');
  const gross=BigInt(refund.amount_atomic),fee=BigInt(refund.fee_atomic),net=BigInt(refund.refund_atomic);
  if(fee+net!==gross||fee!==gross*BigInt(200)/BigInt(10000))throw new Error('Mainnet stake refund accounting mismatch');
  const [day,walletDay,control,authorization]=await Promise.all([
   db.prepare('SELECT reserved_atomic,auto_reserved_atomic FROM mainnet_stake_refund_days WHERE day_utc=?').bind(refund.reserved_day).first<{reserved_atomic:string;auto_reserved_atomic:string}>(),
   db.prepare('SELECT auto_reserved_atomic FROM mainnet_stake_refund_wallet_days WHERE day_utc=? AND lower(wallet_address)=lower(?)').bind(refund.reserved_day,refund.wallet_address).first<{auto_reserved_atomic:string}>(),
   db.prepare('SELECT circuit_open FROM mainnet_stake_refund_control WHERE singleton=1').first<{circuit_open:number}>(),
   db.prepare('SELECT authorization_mode,authorization_status,risk_code,expires_at FROM treasury_job_authorizations WHERE job_id=?').bind(job.job_id).first<JobAuthorization>(),
  ]);
  if(!day||!walletDay||!/^(0|[1-9][0-9]*)$/.test(day.reserved_atomic)||
     !/^(0|[1-9][0-9]*)$/.test(day.auto_reserved_atomic)||!/^(0|[1-9][0-9]*)$/.test(walletDay.auto_reserved_atomic)||
     control?.circuit_open!==0||!authorization||authorization.authorization_status!=='APPROVED'||authorization.expires_at<Date.now())throw new Error('Mainnet stake refund authorization or circuit gate closed');
  if(authorization.authorization_mode==='AUTO'&&(authorization.risk_code!=='NORMAL'||net>limits.maximumSingleAtomic||
     BigInt(day.auto_reserved_atomic)>limits.maximumDailyAtomic||BigInt(walletDay.auto_reserved_atomic)>limits.maximumSingleAtomic))throw new Error('Mainnet automatic stake refund limit invalid');
  if(authorization.authorization_mode!=='AUTO'&&authorization.authorization_mode!=='MANUAL')throw new Error('Mainnet stake refund authorization mode invalid');
 }else{
  if(!job.operation_id?.startsWith('swap:')||job.job_id!==`swap-payout:${job.operation_id}`)throw new Error('Unsupported mainnet treasury payout purpose');
  const intent=await db.prepare("SELECT status,payout_mode,net_usdt_atomic,wallet_address FROM site_swap_intents WHERE intent_id=?").bind(job.operation_id).first<{status:string;payout_mode:string;net_usdt_atomic:string;wallet_address:string}>();
  if(!intent||intent.status!=='CONFIRMED'||intent.payout_mode!=='WALLET'||intent.net_usdt_atomic!==job.amount_atomic||intent.wallet_address.toLowerCase()!==job.recipient_address.toLowerCase())throw new Error('Mainnet Swap payout authorization mismatch');
  const payout=await db.prepare("SELECT status,chain_id,amount_atomic,wallet_address,usdt_token_address FROM site_swap_payouts WHERE intent_id=?").bind(job.operation_id).first<{status:string;chain_id:number;amount_atomic:string;wallet_address:string;usdt_token_address:string}>();
  if(!payout||payout.chain_id!==56||payout.amount_atomic!==job.amount_atomic||payout.wallet_address.toLowerCase()!==job.recipient_address.toLowerCase()||!['READY','PREPARING','SIGNED','SENT'].includes(payout.status)||payout.usdt_token_address.toLowerCase()!==mainnetContracts().usdt.toLowerCase())throw new Error('Mainnet Swap payout obligation mismatch');
 }
 const token=mainnetContracts().usdt;
  // A partially persisted signed job is ambiguous; never allocate a fresh nonce or sign a replacement.
 if((job.tx_hash===null)!==(job.raw_transaction===null)){
  await db.prepare("UPDATE bank_transaction_queue SET last_error='INCOMPLETE_SIGNED_TRANSACTION_REQUIRES_RECONCILIATION' WHERE job_id=? AND chain_id=56 AND status IN ('PREPARING','SIGNED','SENT') AND (last_error IS NULL OR last_error<>'INCOMPLETE_SIGNED_TRANSACTION_REQUIRES_RECONCILIATION')").bind(jobId).first();
  return {processed:false,reason:'incomplete_signed_transaction'};
 }
 if((job.status==='SIGNED'||job.status==='SENT')&&!job.tx_hash&&!job.raw_transaction){
  await db.prepare("UPDATE bank_transaction_queue SET last_error='SIGNED_STATUS_WITHOUT_TRANSACTION_REQUIRES_RECONCILIATION' WHERE job_id=? AND chain_id=56 AND status IN ('SIGNED','SENT') AND raw_transaction IS NULL AND tx_hash IS NULL").bind(jobId).first();
  return {processed:false,reason:'signed_status_without_transaction'};
 }
 if(job.status==='PREPARING'&&!job.tx_hash&&!job.raw_transaction){
  // The isolated signer persists raw bytes and hash before returning. Therefore
  // an expired PREPARING lease with no SIGNED audit can be safely reclaimed.
  if(!job.lease_token||!job.lease_expires_at||job.lease_expires_at>=Date.now())return {processed:false,reason:'signing_lease_active'};
  const signedAudit=await db.prepare("SELECT audit_id FROM treasury_execution_audit WHERE job_id=? AND fencing_token=? AND event='SIGNED'").bind(jobId,job.fencing_token).first<{audit_id:string}>();
  if(signedAudit){await db.prepare("UPDATE bank_transaction_queue SET status='HELD',last_error='SIGNED_AUDIT_WITHOUT_TRANSACTION_REQUIRES_RECONCILIATION' WHERE job_id=? AND chain_id=56 AND status='PREPARING' AND fencing_token=?").bind(jobId,job.fencing_token).first();return {processed:false,reason:'signed_audit_without_transaction'};}
  await db.prepare("UPDATE bank_transaction_queue SET status='PENDING',lease_token=NULL,lease_expires_at=NULL,signing_expires_at=NULL,last_error='EXPIRED_UNSIGNED_LEASE_RECOVERED' WHERE job_id=? AND chain_id=56 AND status='PREPARING' AND fencing_token=? AND raw_transaction IS NULL AND tx_hash IS NULL AND nonce IS NULL").bind(jobId,job.fencing_token).first();
  job=await db.prepare('SELECT * FROM bank_transaction_queue WHERE job_id=? AND chain_id=56').bind(jobId).first<Job>();
  if(!job||job.status!=='PENDING')return {processed:false,reason:'lease_recovery_conflict'};
 }
 if(job.tx_hash&&job.raw_transaction){
   const receiptJob=job;
   const savedHash=receiptJob.tx_hash;
   const savedRaw=receiptJob.raw_transaction;
   if(!savedHash||!savedRaw)return {processed:false,reason:'signed_transaction_missing'};
   if(receiptJob.nonce===null){
    await db.prepare("UPDATE bank_transaction_queue SET last_error='SIGNED_TRANSACTION_MISSING_NONCE_REQUIRES_RECONCILIATION' WHERE job_id=? AND chain_id=56 AND tx_hash=? AND status IN ('PREPARING','SIGNED','SENT')").bind(jobId,savedHash).first();
    return {processed:false,reason:'signed_transaction_missing_nonce'};
   }
   if(keccak256(savedRaw).toLowerCase()!==savedHash.toLowerCase()){
    await db.prepare("UPDATE bank_transaction_queue SET last_error='SIGNED_TRANSACTION_HASH_MISMATCH_REQUIRES_RECONCILIATION' WHERE job_id=? AND chain_id=56 AND tx_hash=? AND status IN ('PREPARING','SIGNED','SENT')").bind(jobId,savedHash).first();
    return {processed:false,reason:'stored_signed_transaction_hash_mismatch'};
   }
   try{
    const receipt=await cfg.client.getTransactionReceipt({hash:savedHash});
    const [latest,tx,block]=await Promise.all([cfg.client.getBlockNumber(),cfg.client.getTransaction({hash:savedHash}),cfg.client.getBlock({blockNumber:receipt.blockNumber})]);
    if(!receipt.blockHash||!tx.blockHash||receipt.transactionHash.toLowerCase()!==savedHash.toLowerCase()||tx.hash.toLowerCase()!==savedHash.toLowerCase()||block.hash!==receipt.blockHash||tx.blockHash!==receipt.blockHash||tx.blockNumber!==receipt.blockNumber){
     await db.prepare("UPDATE bank_transaction_queue SET status='HELD',last_error='MAINNET_PAYOUT_CHAIN_PROOF_MISMATCH_REQUIRES_RECONCILIATION' WHERE job_id=? AND chain_id=56 AND tx_hash=? AND status IN ('PREPARING','SIGNED','SENT')").bind(jobId,savedHash).first();
     return {processed:false,reason:'chain_proof_mismatch_held'};
    }
    if(latest<receipt.blockNumber||latest-receipt.blockNumber+BigInt(1)<BigInt(12))return {processed:false,reason:'confirmations_pending'};
    const expectedData=encodeFunctionData({abi:ERC20,functionName:'transfer',args:[receiptJob.recipient_address,BigInt(receiptJob.amount_atomic)]});
    if(receipt.status!=='success'||tx.chainId!==56||tx.from.toLowerCase()!==receiptJob.sender_address.toLowerCase()||tx.nonce!==receiptJob.nonce||tx.to?.toLowerCase()!==token.toLowerCase()||tx.input.toLowerCase()!==expectedData.toLowerCase()||tx.value!==BigInt(0)){await db.prepare("UPDATE bank_transaction_queue SET status='HELD',last_error='MAINNET_PAYOUT_RECEIPT_REQUIRES_RECONCILIATION' WHERE job_id=? AND chain_id=56 AND tx_hash=? AND status IN ('PREPARING','SIGNED','SENT')").bind(jobId,savedHash).first();return {processed:false,reason:'receipt_held'};}
    const paid=receipt.logs.some(log=>{if(log.address.toLowerCase()!==token.toLowerCase())return false;try{return log.topics.length===3&&log.topics[0]?.toLowerCase()==='0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'&&('0x'+log.topics[1]?.slice(-40)).toLowerCase()===receiptJob.sender_address.toLowerCase()&&('0x'+log.topics[2]?.slice(-40)).toLowerCase()===receiptJob.recipient_address.toLowerCase()&&BigInt(log.data)===BigInt(receiptJob.amount_atomic);}catch{return false;}});
    if(!paid){await db.prepare("UPDATE bank_transaction_queue SET status='HELD',last_error='MAINNET_PAYOUT_TRANSFER_LOG_REQUIRES_RECONCILIATION' WHERE job_id=? AND chain_id=56 AND tx_hash=? AND status IN ('PREPARING','SIGNED','SENT')").bind(jobId,savedHash).first();return {processed:false,reason:'receipt_held'};}
    const now=Date.now();const statements=[
     db.prepare("UPDATE bank_transaction_queue SET status='CONFIRMED',confirmed_at=?,last_error=NULL WHERE job_id=? AND chain_id=56 AND tx_hash=? AND status IN ('SIGNED','SENT','PREPARING')").bind(now,jobId,savedHash),
    ];
    if(!isStakeRefund)statements.push(db.prepare("UPDATE site_swap_payouts SET status='CONFIRMED',tx_hash=?,confirmed_at=?,updated_at=?,last_error=NULL WHERE intent_id=? AND status IN ('READY','PREPARING','SIGNED','SENT') AND EXISTS(SELECT 1 FROM bank_transaction_queue WHERE job_id=? AND chain_id=56 AND operation_id=site_swap_payouts.intent_id AND tx_hash=? AND status='CONFIRMED')").bind(savedHash,now,now,receiptJob.operation_id,jobId,savedHash));
    statements.push(db.prepare(`INSERT OR IGNORE INTO treasury_execution_audit
      (audit_id,job_id,fencing_token,event,job_fingerprint,tx_hash,nonce,created_at,details_json)
      SELECT job_id||':'||fencing_token||':CONFIRMED',job_id,fencing_token,'CONFIRMED',job_fingerprint,tx_hash,nonce,?,'{"confirmations":12}'
      FROM bank_transaction_queue WHERE job_id=? AND chain_id=56 AND status='CONFIRMED' AND tx_hash=?`).bind(now,jobId,savedHash));
    const results=await db.batch(statements);
    if(results[0]?.meta?.changes!==1||(!isStakeRefund&&results[1]?.meta?.changes!==1)){
     await db.prepare("UPDATE bank_transaction_queue SET status='HELD',last_error='CONFIRMATION_ROW_MISMATCH_REQUIRES_RECONCILIATION' WHERE job_id=? AND chain_id=56 AND tx_hash=? AND status IN ('PREPARING','SIGNED','SENT')").bind(jobId,savedHash).first();
     await db.prepare("UPDATE bank_transaction_queue SET last_error='CONFIRMED_PAYOUT_ROW_MISMATCH_REQUIRES_RECONCILIATION' WHERE job_id=? AND chain_id=56 AND tx_hash=? AND status='CONFIRMED'").bind(jobId,savedHash).first();
     return {processed:false,reason:'confirmation_row_mismatch'};
    }
    return {processed:true,status:'CONFIRMED'};
   }catch(e){if(e instanceof Error&&e.name==='TransactionNotFoundError')return {processed:false,reason:'receipt_transaction_lookup_pending'};if(!(e instanceof Error)||e.name!=='TransactionReceiptNotFoundError')throw e;
    // If the node has no transaction/receipt yet, rebroadcast only the exact persisted signed bytes.
    // Never allocate a new nonce or sign a replacement during recovery.
   }
   try{const hash=await cfg.client.sendRawTransaction({serializedTransaction:savedRaw});if(hash.toLowerCase()!==savedHash.toLowerCase()){await db.prepare("UPDATE bank_transaction_queue SET status='HELD',last_error='BROADCAST_HASH_MISMATCH_REQUIRES_RECONCILIATION' WHERE job_id=? AND chain_id=56 AND tx_hash=? AND status IN ('SIGNED','SENT')").bind(jobId,savedHash).first();return {processed:false,reason:'broadcast_hash_mismatch_held'};}await db.batch([db.prepare("UPDATE bank_transaction_queue SET status='SENT',last_error=NULL WHERE job_id=? AND chain_id=56 AND tx_hash=? AND status IN ('SIGNED','SENT')").bind(jobId,savedHash),db.prepare(`INSERT OR IGNORE INTO treasury_execution_audit (audit_id,job_id,fencing_token,event,job_fingerprint,tx_hash,nonce,created_at,details_json) SELECT job_id||':'||fencing_token||':BROADCAST',job_id,fencing_token,'BROADCAST',job_fingerprint,tx_hash,nonce,?,'{"recovery":true}' FROM bank_transaction_queue WHERE job_id=? AND chain_id=56 AND tx_hash=?`).bind(Date.now(),jobId,savedHash)]);return {processed:true,status:'SENT'};}catch(e){await db.prepare("UPDATE bank_transaction_queue SET last_error=? WHERE job_id=? AND chain_id=56 AND tx_hash=? AND status IN ('SIGNED','SENT')").bind(e instanceof Error?e.name:'BroadcastError',jobId,savedHash).first();return {processed:false,reason:'broadcast_pending'};}
  }
 const decimals=await cfg.client.readContract({address:token,abi:ERC20,functionName:'decimals'});
 if(decimals!==18)throw new Error('Mainnet USDT decimals mismatch');
 const balance=await cfg.client.readContract({address:token,abi:ERC20,functionName:'balanceOf',args:[cfg.address]});
 if(balance<BigInt(job.amount_atomic))return {processed:false,reason:'insufficient_token_balance'};
 // Never allocate a nonce while another treasury job has an unresolved signed transaction.
 // This conservative gate favors delayed payment over ambiguous double broadcasts.
 const active=await db.prepare("SELECT job_id FROM bank_transaction_queue WHERE chain_id=56 AND sender_address=? AND job_id<>? AND (status IN ('PREPARING','SIGNED','SENT') OR (status='HELD' AND (nonce IS NOT NULL OR tx_hash IS NOT NULL OR raw_transaction IS NOT NULL))) LIMIT 1").bind(cfg.address,jobId).first<{job_id:string}>();
 if(active)return {processed:false,reason:'sender_has_unresolved_transaction'};
 // Atomic sender reservation: only one pending Treasury job may enter PREPARING.
 // The fencing token prevents a stale invocation from persisting a signature.
 const leaseToken=crypto.randomUUID(),leaseNow=Date.now(),leaseExpires=leaseNow+30000;
 const reserved=await db.prepare("UPDATE bank_transaction_queue SET status='PREPARING',lease_token=?,lease_expires_at=?,signing_expires_at=?,fencing_token=fencing_token+1 WHERE job_id=? AND chain_id=56 AND status='PENDING' AND nonce IS NULL AND raw_transaction IS NULL AND tx_hash IS NULL AND NOT EXISTS (SELECT 1 FROM bank_transaction_queue other WHERE other.chain_id=56 AND other.sender_address=bank_transaction_queue.sender_address AND other.job_id<>bank_transaction_queue.job_id AND (other.status IN ('PREPARING','SIGNED','SENT') OR (other.status='HELD' AND (other.nonce IS NOT NULL OR other.raw_transaction IS NOT NULL OR other.tx_hash IS NOT NULL)))) RETURNING job_id,fencing_token").bind(leaseToken,leaseExpires,leaseExpires,jobId).first<{job_id:string;fencing_token:number}>();
 if(!reserved)return {processed:false,reason:'sender_busy_or_job_not_claimed'};
 const signed=await cfg.signTreasuryJob(jobId,leaseToken,reserved.fencing_token);
 job=await db.prepare('SELECT * FROM bank_transaction_queue WHERE job_id=? AND chain_id=56').bind(jobId).first<Job>();
 if(!job?.raw_transaction||!job.tx_hash||job.tx_hash.toLowerCase()!==signed.txHash.toLowerCase()||job.nonce!==signed.nonce||job.fencing_token!==reserved.fencing_token||job.lease_token!==leaseToken)return {processed:false,reason:'signer_persistence_mismatch'};
 try{const returned=await cfg.client.sendRawTransaction({serializedTransaction:job.raw_transaction});if(returned.toLowerCase()!==job.tx_hash.toLowerCase()){await db.prepare("UPDATE bank_transaction_queue SET status='HELD',last_error='INITIAL_BROADCAST_HASH_MISMATCH_REQUIRES_RECONCILIATION' WHERE job_id=? AND chain_id=56 AND tx_hash=? AND status='SIGNED'").bind(jobId,job.tx_hash).first();return {processed:false,reason:'initial_broadcast_hash_mismatch_held'};}await db.batch([db.prepare("UPDATE bank_transaction_queue SET status='SENT',last_error=NULL WHERE job_id=? AND chain_id=56 AND tx_hash=? AND status='SIGNED'").bind(jobId,job.tx_hash),db.prepare(`INSERT OR IGNORE INTO treasury_execution_audit (audit_id,job_id,fencing_token,event,job_fingerprint,tx_hash,nonce,created_at,details_json) SELECT job_id||':'||fencing_token||':BROADCAST',job_id,fencing_token,'BROADCAST',job_fingerprint,tx_hash,nonce,?,'{"recovery":false}' FROM bank_transaction_queue WHERE job_id=? AND chain_id=56 AND tx_hash=?`).bind(Date.now(),jobId,job.tx_hash)]);return {processed:true,status:'SENT'};}catch(e){await db.prepare("UPDATE bank_transaction_queue SET last_error=? WHERE job_id=? AND chain_id=56 AND tx_hash=? AND status='SIGNED'").bind(e instanceof Error?e.name:'BroadcastError',jobId,job.tx_hash).first();return {processed:false,reason:'broadcast_pending'};}
}
export async function pumpMainnetBankQueue(limit=5){
 if(!mainnetBankEnabled())return {processed:0};
 const db=serverDB(),jobs=await db.prepare("SELECT job_id FROM bank_transaction_queue WHERE chain_id=56 AND job_id='swap-payout:'||operation_id AND operation_id LIKE 'swap:%' AND status IN ('PENDING','PREPARING','SIGNED','SENT') ORDER BY CASE status WHEN 'SENT' THEN 0 WHEN 'SIGNED' THEN 1 WHEN 'PREPARING' THEN 2 ELSE 3 END, created_at LIMIT ?").bind(Math.max(1,Math.min(20,limit))).all<{job_id:string}>();
 let processed=0;for(const job of jobs.results){try{const result=await processMainnetBankJob(job.job_id);if(result.processed)processed++;}catch(e){console.error(JSON.stringify({event:'mainnet_bank_payout_retry',jobId:job.job_id,error:e instanceof Error?e.name:'UnknownError'}));}}
 return {processed};
}
