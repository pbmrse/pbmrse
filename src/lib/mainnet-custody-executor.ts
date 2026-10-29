import {getCloudflareContext} from '@opennextjs/cloudflare';
import {createPublicClient,encodeFunctionData,http,keccak256,parseAbi,type Address,type Hash,type Hex} from 'viem';
import {authenticatedSignerRequest,validSignerCallerSecret} from './signer-service-auth';
import {confirmCustodyCollection,createPlatformGasReturn,releaseCustodyCollectionAfterGas} from './mainnet-custody-storage';
import {serverDB,type Database} from './server-db';

const ERC20=parseAbi(['function transfer(address to,uint256 amount) returns (bool)']);
type InternalFetcher={fetch(request:Request):Promise<Response>};
type WorkerEnv=Record<string,unknown>;
type Job={job_id:string;receipt_id:string;owner_wallet:string;custody_address:string;purpose:string;signer_kind:string;sender_address:Address;recipient_address:Address;asset:'BNB'|'ERC20';token_address:Address|null;amount_atomic:string;status:string;nonce:number|null;raw_transaction:Hex|null;tx_hash:Hash|null;lease_token:string|null;lease_expires_at:number|null;fencing_token:number;signing_expires_at:number|null};
const envValue=(env:WorkerEnv,name:string)=>{const v=Reflect.get(env,name);return typeof v==='string'&&v?v:undefined;};

async function ensureExecutionGas(db:Database,client:ReturnType<typeof createPublicClient>,env:WorkerEnv,job:Job){
 if(job.status!=='PENDING'||job.asset!=='ERC20'||job.signer_kind!=='CUSTODY')return false;
 const gasWallet=envValue(env,'MAINNET_CUSTODY_GAS_ADDRESS');
 const topupCap=envValue(env,'MAINNET_CUSTODY_GAS_TOPUP_WEI');
 if(!gasWallet||!/^0x[0-9a-f]{40}$/i.test(gasWallet)||!topupCap||!/^[1-9][0-9]{0,77}$/.test(topupCap))throw new Error('CUSTODY_GAS_CONFIG_INVALID');
 const [balance,gasPrice]=await Promise.all([client.getBalance({address:job.sender_address}),client.getGasPrice()]);
 const required=gasPrice*100000n;
 if(balance>=required)return false;
 const deficit=required-balance;
 if(deficit>BigInt(topupCap))throw new Error('CUSTODY_RUNTIME_GAS_DEFICIT_EXCEEDS_CAP');
 const topupJobId=`custody:gas-topup-runtime:${job.job_id}`;
 const inserted=await db.prepare(`INSERT INTO custody_collection_jobs
   (job_id,receipt_id,owner_wallet,custody_address,purpose,signer_kind,sender_address,recipient_address,chain_id,asset,token_address,amount_atomic,status,created_at)
   SELECT ?,receipt_id,owner_wallet,custody_address,'GAS_TOPUP','GAS_WALLET',?,custody_address,56,'BNB',NULL,?,'PENDING',?
   FROM custody_collection_jobs WHERE job_id=? AND status='PENDING'
   AND NOT EXISTS(SELECT 1 FROM custody_collection_jobs active WHERE lower(active.custody_address)=lower(custody_collection_jobs.custody_address)
     AND active.purpose='GAS_TOPUP' AND active.status IN ('PENDING','PREPARING','SIGNED','SENT','HELD'))
   ON CONFLICT(job_id) DO NOTHING`).bind(topupJobId,gasWallet.toLowerCase(),deficit.toString(),Date.now(),job.job_id).run() as {meta?:{changes?:number}};
 const existing=await db.prepare("SELECT status FROM custody_collection_jobs WHERE job_id=? AND purpose='GAS_TOPUP'").bind(topupJobId).first<{status:string}>();
 if(inserted.meta?.changes===1||existing&&['PENDING','PREPARING','SIGNED','SENT','CONFIRMED'].includes(existing.status))return true;
 const active=await db.prepare("SELECT job_id FROM custody_collection_jobs WHERE lower(custody_address)=lower(?) AND purpose='GAS_TOPUP' AND status IN ('PENDING','PREPARING','SIGNED','SENT','HELD') LIMIT 1").bind(job.custody_address).first<{job_id:string}>();
 if(active)return true;
 throw new Error('CUSTODY_RUNTIME_GAS_TOPUP_CONFLICT');
}

async function signer(env:WorkerEnv,jobId:string,leaseToken:string,fencingToken:number){
 const binding=Reflect.get(env,'CUSTODY_SIGNER') as InternalFetcher|undefined,secret=envValue(env,'CUSTODY_SIGNER_CALLER_SECRET');
 if(!binding||!validSignerCallerSecret(secret))throw new Error('CUSTODY_SIGNER_BINDING_UNAVAILABLE');
 const body=JSON.stringify({jobId,leaseToken,fencingToken});
 const request=await authenticatedSignerRequest('https://custody-signer.internal/v1/sign',body,secret,'pbmrse-custody-signer:v1');
 const response=await binding.fetch(request);if(!response.ok)throw new Error('CUSTODY_SIGNER_REJECTED');
 return response.json() as Promise<{jobId:string;txHash:Hash;nonce:number;status:'SIGNED'}>;
}

async function confirm(db:Database,client:ReturnType<typeof createPublicClient>,job:Job){
 if(!job.tx_hash||!job.raw_transaction||job.nonce===null||keccak256(job.raw_transaction).toLowerCase()!==job.tx_hash.toLowerCase())throw new Error('CUSTODY_SIGNED_TRANSACTION_INVALID');
 let receipt;try{receipt=await client.getTransactionReceipt({hash:job.tx_hash});}catch(error){if(error instanceof Error&&error.name==='TransactionReceiptNotFoundError')return {processed:false,reason:'receipt_pending'};throw error;}
 const [tx,block,latest]=await Promise.all([client.getTransaction({hash:job.tx_hash}),client.getBlock({blockNumber:receipt.blockNumber}),client.getBlockNumber()]);
 if(!receipt.blockHash||tx.blockHash!==receipt.blockHash||block.hash!==receipt.blockHash||latest<receipt.blockNumber||latest-receipt.blockNumber+1n<12n||tx.chainId!==56||tx.from.toLowerCase()!==job.sender_address.toLowerCase()||tx.nonce!==job.nonce)return {processed:false,reason:'chain_proof_pending_or_invalid'};
 if(receipt.status!=='success'){
 await db.batch([
   db.prepare("UPDATE custody_collection_jobs SET status='FAILED',confirmed_at=?,last_error='COLLECTION_TRANSACTION_REVERTED' WHERE job_id=? AND status IN ('SIGNED','SENT') AND lower(tx_hash)=lower(?)").bind(Date.now(),job.job_id,job.tx_hash),
   db.prepare("UPDATE custody_daily_reservations SET state='RELEASED',released_at=? WHERE job_id=? AND state='RESERVED'").bind(Date.now(),job.job_id),
   db.prepare("UPDATE custody_asset_receipts SET status='READY_TO_COLLECT',last_error='COLLECTION_TRANSACTION_REVERTED' WHERE receipt_id=? AND status='COLLECTING'").bind(job.receipt_id),
  ]);
  return {processed:false,reason:'collection_failed_reconciliation_required'};
 }
 if(job.asset==='BNB'){
  if(tx.to?.toLowerCase()!==job.recipient_address.toLowerCase()||tx.value!==BigInt(job.amount_atomic)||tx.input!=='0x')throw new Error('CUSTODY_BNB_TRANSFER_MISMATCH');
 }else{
  const data=encodeFunctionData({abi:ERC20,functionName:'transfer',args:[job.recipient_address,BigInt(job.amount_atomic)]});
  if(tx.to?.toLowerCase()!==job.token_address?.toLowerCase()||tx.value!==0n||tx.input.toLowerCase()!==data.toLowerCase())throw new Error('CUSTODY_TOKEN_TRANSFER_MISMATCH');
 }
 const now=Date.now(),gasSpent=(receipt.gasUsed*(receipt.effectiveGasPrice??tx.gasPrice??0n)).toString();
 if(job.purpose==='GAS_TOPUP'){
  await db.batch([
   db.prepare(`INSERT INTO custody_gas_ledger(event_id,owner_wallet,custody_address,kind,amount_atomic,tx_hash,block_number,related_job_id,created_at)
    VALUES (?,?,?,'PLATFORM_TOPUP',?,?,?,?,?) ON CONFLICT(event_id) DO NOTHING`).bind(`platform-topup:${job.job_id}`,job.owner_wallet,job.custody_address,job.amount_atomic,job.tx_hash,Number(receipt.blockNumber),job.job_id,now),
  ]);
  const topup=await db.prepare("SELECT amount_atomic,tx_hash FROM custody_gas_ledger WHERE event_id=? AND kind='PLATFORM_TOPUP'").bind(`platform-topup:${job.job_id}`).first<{amount_atomic:string;tx_hash:string}>();
  if(!topup||topup.amount_atomic!==job.amount_atomic||topup.tx_hash.toLowerCase()!==job.tx_hash.toLowerCase())throw new Error('CUSTODY_GAS_TOPUP_LEDGER_CONFLICT');
  await releaseCustodyCollectionAfterGas(db,job.job_id,job.tx_hash,now);
 }else if(job.purpose==='PLATFORM_GAS_RETURN'){
  const results=await db.batch([
   db.prepare("UPDATE custody_collection_jobs SET status='CONFIRMED',confirmed_at=?,last_error=NULL WHERE job_id=? AND status IN ('SIGNED','SENT') AND lower(tx_hash)=lower(?)").bind(now,job.job_id,job.tx_hash),
   db.prepare(`INSERT INTO custody_gas_ledger(event_id,owner_wallet,custody_address,kind,amount_atomic,tx_hash,block_number,related_job_id,created_at) VALUES (?,?,?,'PLATFORM_GAS_RETURN',?,?,?,?,?)`).bind(`platform-return:${job.job_id}`,job.owner_wallet,job.custody_address,job.amount_atomic,job.tx_hash,Number(receipt.blockNumber),job.job_id,now),
   db.prepare(`INSERT INTO custody_gas_ledger(event_id,owner_wallet,custody_address,kind,amount_atomic,tx_hash,block_number,related_job_id,created_at) VALUES (?,?,?,'CHAIN_GAS_SPENT',?,?,?,?,?)`).bind(`gas-spent:${job.job_id}`,job.owner_wallet,job.custody_address,gasSpent,job.tx_hash,Number(receipt.blockNumber),job.job_id,now),
  ]);if(results.some(result=>result.meta.changes!==1))throw new Error('CUSTODY_GAS_RETURN_CONFIRMATION_CONFLICT');
 }else await confirmCustodyCollection(db,{jobId:job.job_id,txHash:job.tx_hash,blockNumber:Number(receipt.blockNumber),gasSpentAtomic:gasSpent,now});
 return {processed:true,status:'CONFIRMED'};
}

export async function processCustodyCollectionJob(jobId:string){
 const env=getCloudflareContext().env as unknown as WorkerEnv;
 if(envValue(env,'APP_NETWORK')!=='bsc-mainnet'||envValue(env,'MAINNET_FINANCIAL_MODE')!=='enabled'||envValue(env,'MAINNET_BANK_ENABLED')!=='true'||envValue(env,'MAINNET_CUSTODY_COLLECTION_READY')!=='true'||envValue(env,'MAINNET_GAS_AUTO_TOPUP_ENABLED')!=='true')throw new Error('CUSTODY_COLLECTION_DISABLED');
 const rpc=envValue(env,'BSC_MAINNET_RPC_URL');if(!rpc)throw new Error('CUSTODY_RPC_UNAVAILABLE');const client=createPublicClient({transport:http(rpc,{timeout:15000,retryCount:1})});if(await client.getChainId()!==56)throw new Error('CUSTODY_RPC_CHAIN_MISMATCH');
 const db=serverDB();let job=await db.prepare('SELECT * FROM custody_collection_jobs WHERE job_id=? AND chain_id=56').bind(jobId).first<Job>();if(!job||['CONFIRMED','FAILED','HELD'].includes(job.status))return {processed:false};
 if((job.raw_transaction===null)!==(job.tx_hash===null)){await db.prepare("UPDATE custody_collection_jobs SET status='HELD',last_error='INCOMPLETE_SIGNED_TRANSACTION' WHERE job_id=?").bind(jobId).run();return {processed:false,reason:'reconciliation_required'};}
 if((job.status==='SIGNED'||job.status==='SENT')&&!job.raw_transaction&&!job.tx_hash){await db.prepare("UPDATE custody_collection_jobs SET status='HELD',last_error='SIGNED_STATUS_WITHOUT_TRANSACTION' WHERE job_id=? AND status IN ('SIGNED','SENT')").bind(jobId).run();return {processed:false,reason:'reconciliation_required'};}
 if(job.tx_hash&&job.raw_transaction){
  const result=await confirm(db,client,job);if(result.processed||result.reason!=='receipt_pending')return result;
  try{const sent=await client.sendRawTransaction({serializedTransaction:job.raw_transaction});if(sent.toLowerCase()!==job.tx_hash.toLowerCase())throw new Error('CUSTODY_BROADCAST_HASH_MISMATCH');await db.prepare("UPDATE custody_collection_jobs SET status='SENT',last_error=NULL WHERE job_id=? AND tx_hash=? AND status IN ('SIGNED','SENT')").bind(jobId,job.tx_hash).run();return {processed:true,status:'SENT'};}catch(error){await db.prepare('UPDATE custody_collection_jobs SET last_error=? WHERE job_id=? AND status IN (\'SIGNED\',\'SENT\')').bind(error instanceof Error?error.name:'BroadcastError',jobId).run();return {processed:false,reason:'broadcast_unknown'};}
 }
 if(await ensureExecutionGas(db,client,env,job))return {processed:false,reason:'awaiting_runtime_gas_topup'};
 if(job.status==='PREPARING'){
  if(job.lease_expires_at&&job.lease_expires_at>Date.now())return {processed:false,reason:'lease_active'};
  const audit=await db.prepare("SELECT audit_id FROM custody_signing_audit WHERE job_id=? AND fencing_token=? AND event='SIGNED'").bind(jobId,job.fencing_token).first<{audit_id:string}>();
  if(audit){await db.prepare("UPDATE custody_collection_jobs SET status='HELD',last_error='SIGNED_AUDIT_WITHOUT_TRANSACTION' WHERE job_id=?").bind(jobId).run();return {processed:false,reason:'reconciliation_required'};}
  await db.prepare("UPDATE custody_collection_jobs SET status='PENDING',lease_token=NULL,lease_expires_at=NULL,signing_expires_at=NULL,last_error='EXPIRED_UNSIGNED_LEASE_RECOVERED' WHERE job_id=? AND status='PREPARING' AND raw_transaction IS NULL AND tx_hash IS NULL").bind(jobId).run();
 }
 const lease=crypto.randomUUID(),expires=Date.now()+30000;
 const reserved=await db.prepare(`UPDATE custody_collection_jobs SET status='PREPARING',lease_token=?,lease_expires_at=?,signing_expires_at=?,fencing_token=fencing_token+1
   WHERE job_id=? AND status='PENDING' AND nonce IS NULL AND raw_transaction IS NULL AND tx_hash IS NULL
   AND NOT EXISTS(SELECT 1 FROM custody_collection_jobs active WHERE lower(active.sender_address)=lower(custody_collection_jobs.sender_address)
     AND active.job_id<>custody_collection_jobs.job_id AND (active.status IN ('PREPARING','SIGNED','SENT')
       OR (active.status='HELD' AND (active.nonce IS NOT NULL OR active.tx_hash IS NOT NULL OR active.raw_transaction IS NOT NULL))))
   RETURNING fencing_token`).bind(lease,expires,expires,jobId).first<{fencing_token:number}>();if(!reserved)return {processed:false,reason:'not_claimed_or_sender_busy'};
 await db.prepare("UPDATE custody_asset_receipts SET status='COLLECTING' WHERE receipt_id=(SELECT receipt_id FROM custody_collection_jobs WHERE job_id=?) AND status='READY_TO_COLLECT'").bind(jobId).run();
 let signed;
 try{signed=await signer(env,jobId,lease,reserved.fencing_token);}catch(error){
  await db.prepare("UPDATE custody_collection_jobs SET last_error='CUSTODY_SIGNER_REJECTED' WHERE job_id=? AND status='PREPARING' AND lease_token=? AND fencing_token=?")
   .bind(jobId,lease,reserved.fencing_token).run();
  throw error;
 }
 job=await db.prepare('SELECT * FROM custody_collection_jobs WHERE job_id=?').bind(jobId).first<Job>();
 if(!job?.raw_transaction||!job.tx_hash||job.tx_hash.toLowerCase()!==signed.txHash.toLowerCase()||job.nonce!==signed.nonce)throw new Error('CUSTODY_SIGNER_PERSISTENCE_MISMATCH');
 try{const sent=await client.sendRawTransaction({serializedTransaction:job.raw_transaction});if(sent.toLowerCase()!==job.tx_hash.toLowerCase())throw new Error('CUSTODY_BROADCAST_HASH_MISMATCH');await db.prepare("UPDATE custody_collection_jobs SET status='SENT',last_error=NULL WHERE job_id=? AND status='SIGNED' AND tx_hash=?").bind(jobId,job.tx_hash).run();return {processed:true,status:'SENT'};}catch(error){await db.prepare("UPDATE custody_collection_jobs SET last_error=? WHERE job_id=? AND status='SIGNED'").bind(error instanceof Error?error.name:'BroadcastError',jobId).run();return {processed:false,reason:'broadcast_unknown'};}
}

export async function pumpCustodyCollection(limit=5){
 if(!Number.isSafeInteger(limit)||limit<1||limit>10)throw new Error('CUSTODY_BATCH_LIMIT_INVALID');const env=getCloudflareContext().env as unknown as WorkerEnv;
 if(envValue(env,'MAINNET_FINANCIAL_MODE')!=='enabled'||envValue(env,'MAINNET_CUSTODY_COLLECTION_READY')!=='true'||envValue(env,'MAINNET_GAS_AUTO_TOPUP_ENABLED')!=='true')return {processed:0};
 const jobs=await serverDB().prepare("SELECT job_id FROM custody_collection_jobs WHERE status IN ('PENDING','PREPARING','SIGNED','SENT') ORDER BY CASE status WHEN 'SENT' THEN 0 WHEN 'SIGNED' THEN 1 WHEN 'PREPARING' THEN 2 ELSE 3 END,created_at LIMIT ?").bind(limit).all<{job_id:string}>();let processed=0;
 for(const job of jobs.results){try{if((await processCustodyCollectionJob(job.job_id)).processed)processed++;}catch(error){console.error(JSON.stringify({event:'custody_collection_retry',jobId:job.job_id,error:error instanceof Error?error.name:'UnknownError'}));}}
 const rpc=envValue(env,'BSC_MAINNET_RPC_URL');if(rpc){const client=createPublicClient({transport:http(rpc,{timeout:15000,retryCount:1})});
  const receipts=await serverDB().prepare(`SELECT r.receipt_id,r.custody_address FROM custody_asset_receipts r WHERE r.status='COLLECTED'
    AND r.receipt_id=(SELECT r2.receipt_id FROM custody_asset_receipts r2 WHERE r2.status='COLLECTED' AND lower(r2.custody_address)=lower(r.custody_address) ORDER BY r2.collected_at DESC,r2.receipt_id DESC LIMIT 1)
    AND NOT EXISTS(SELECT 1 FROM custody_collection_jobs j WHERE lower(j.custody_address)=lower(r.custody_address) AND j.purpose='PLATFORM_GAS_RETURN'
      AND j.status IN ('PENDING','PREPARING','SIGNED','SENT','HELD'))
    AND NOT EXISTS(SELECT 1 FROM custody_collection_jobs active WHERE active.custody_address=r.custody_address
      AND active.status IN ('PENDING','PREPARING','SIGNED','SENT','HELD')) ORDER BY r.collected_at LIMIT ?`).bind(limit).all<{receipt_id:string;custody_address:Address}>();
  for(const receipt of receipts.results){try{const [balance,gasPrice]=await Promise.all([client.getBalance({address:receipt.custody_address}),client.getGasPrice()]);const fee=gasPrice*21000n;if(balance>fee)await createPlatformGasReturn(serverDB(),{receiptId:receipt.receipt_id,collectionAddress:envValue(env,'MAINNET_CUSTODY_COLLECTION_ADDRESS') as Address,chainBalanceAtomic:balance.toString(),returnGasCostAtomic:fee.toString()});}catch(error){console.error(JSON.stringify({event:'custody_gas_return_planning_failed',receiptId:receipt.receipt_id,error:error instanceof Error?error.name:'UnknownError'}));}}
 }
 return {processed};
}
