import {getCloudflareContext} from '@opennextjs/cloudflare';
import {createPublicClient,getAddress,http,isAddress,toHex,type Address,type Hash} from 'viem';
import {bsc} from 'viem/chains';
import {minimumPlatformGasTopup} from './mainnet-custody-policy';
import {recordCustodyReceipt} from './mainnet-custody-storage';
import {normalizeMainnetStakeConfirmation,recoverMainnetStakePayment} from './mainnet-stake-confirmation';
import {serverDB,type Database} from './server-db';
import {MAINNET_STAKE_TEST_WALLET} from './mainnet-stake-test-gate';

const TRANSFER_TOPIC='0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const CONFIRMATIONS=12n;
const DEFAULT_ADDRESS_LIMIT=1;
const DEFAULT_BLOCK_LIMIT=100;
const VERIFIED_PUBLIC_SCAN_RPCS=['https://bsc-rpc.publicnode.com','https://1rpc.io/bnb'];
type WorkerEnv=Record<string,unknown>;
type ScanState={custody_address:string;owner_wallet:string;next_block:number;last_scanned_block:number|null;last_scanned_block_hash:string|null;status:string;lease_token:string;consecutive_failures:number;retry_after:number|null};
type Detected={kind:'TOKEN'|'NATIVE';tokenAddress:Address|null;symbol:string;source:Address;amount:bigint;txHash:Hash;logIndex:number;blockNumber:bigint;blockHash:Hash};
type RpcReceiptLog={address:string;topics:string[];data:string;transactionHash:string;logIndex:string;blockNumber:string;blockHash:string};
type RpcReceipt={logs:RpcReceiptLog[]};

const envString=(env:WorkerEnv,name:string)=>{const value=Reflect.get(env,name);return typeof value==='string'&&value?value:undefined;};
function positiveLimit(env:WorkerEnv,name:string,fallback:number,max:number){const raw=envString(env,name);if(!raw)return fallback;if(!/^[1-9][0-9]*$/.test(raw))throw new Error('CUSTODY_SCAN_LIMIT_INVALID');const value=Number(raw);if(!Number.isSafeInteger(value)||value>max)throw new Error('CUSTODY_SCAN_LIMIT_INVALID');return value;}
function scannerEnabled(env:WorkerEnv){
 const admission=envString(env,'MAINNET_STAKE_PUBLIC_ENABLED')==='true'||
  (envString(env,'MAINNET_STAKE_TEST_GATE_ENABLED')==='true'&&envString(env,'MAINNET_ACCEPTANCE_TEST_PHASE')==='STAKE');
 return envString(env,'APP_NETWORK')==='bsc-mainnet'&&envString(env,'MAINNET_CUSTODY_SCAN_ENABLED')==='true'&&
  envString(env,'MAINNET_CUSTODY_COLLECTION_READY')==='true'&&admission;
}
function scannerRpcUrls(env:WorkerEnv){
 const configured=envString(env,'BSC_MAINNET_SCAN_RPC_URLS');let values:string[]=[];
 if(configured){try{const parsed=JSON.parse(configured) as unknown;if(!Array.isArray(parsed)||parsed.length<1||parsed.length>3||parsed.some(value=>typeof value!=='string'))throw new Error();values=parsed as string[];}catch{throw new Error('CUSTODY_SCAN_RPC_CONFIG_INVALID');}}
 const fallback=envString(env,'BSC_MAINNET_RPC_URL');if(fallback)values.push(fallback);
 const unique=[...new Set([...values,...VERIFIED_PUBLIC_SCAN_RPCS])];
 if(unique.length<1||unique.some(value=>{try{const url=new URL(value);return url.protocol!=='https:'||Boolean(url.username)||Boolean(url.password);}catch{return true;}}))throw new Error('CUSTODY_SCAN_RPC_CONFIG_INVALID');
 return unique;
}

function receiptTokenEvents(receipts:RpcReceipt[],tokens:Map<string,string>,custody:Address){
 const detected:Detected[]=[];
 for(const receipt of receipts){for(const log of receipt.logs??[]){
  const symbol=tokens.get(log.address?.toLowerCase());if(!symbol||log.topics?.[0]?.toLowerCase()!==TRANSFER_TOPIC||log.topics.length<3)continue;
  const sourceTopic=log.topics[1],targetTopic=log.topics[2];
  if(!/^0x[0-9a-fA-F]{64}$/.test(sourceTopic)||!/^0x[0-9a-fA-F]{64}$/.test(targetTopic)||!/^0x[0-9a-fA-F]{64}$/.test(log.data))throw new Error('CUSTODY_TOKEN_LOG_INCOMPLETE');
  const source=getAddress(`0x${sourceTopic.slice(-40)}`),target=getAddress(`0x${targetTopic.slice(-40)}`);if(target.toLowerCase()!==custody.toLowerCase())continue;
  if(!/^0x[0-9a-fA-F]{64}$/.test(log.transactionHash)||!/^0x[0-9a-fA-F]{64}$/.test(log.blockHash)||!/^0x[0-9a-fA-F]+$/.test(log.logIndex)||!/^0x[0-9a-fA-F]+$/.test(log.blockNumber))throw new Error('CUSTODY_TOKEN_LOG_INCOMPLETE');
  const amount=BigInt(log.data);if(amount>0n)detected.push({kind:'TOKEN',tokenAddress:getAddress(log.address),symbol,source,amount,txHash:log.transactionHash as Hash,logIndex:Number(BigInt(log.logIndex)),blockNumber:BigInt(log.blockNumber),blockHash:log.blockHash as Hash});
 }}
 return detected;
}

async function gasTopup(db:Database,gasPrice:bigint,custodyAddress:Address,maximumTopupAtomic:string){
 if(!/^[1-9][0-9]{0,77}$/.test(maximumTopupAtomic))throw new Error('CUSTODY_GAS_CONFIG_INVALID');
 const rows=await db.prepare('SELECT kind,amount_atomic FROM custody_gas_ledger WHERE lower(custody_address)=lower(?)').bind(custodyAddress).all<{kind:string;amount_atomic:string}>();
 const total=(kind:string)=>rows.results.filter(row=>row.kind===kind).reduce((sum,row)=>sum+BigInt(row.amount_atomic),0n);
 return minimumPlatformGasTopup({gasPriceAtomic:gasPrice,collectionGasLimit:100000n,returnGasLimit:21000n,
  platformTopupAtomic:total('PLATFORM_TOPUP'),gasSpentAtomic:total('CHAIN_GAS_SPENT'),platformReturnedAtomic:total('PLATFORM_GAS_RETURN'),maximumTopupAtomic:BigInt(maximumTopupAtomic)}).topupAtomic;
}

async function matchingStake(db:Database,state:ScanState,event:Detected){
 // A previously confirmed payment is authoritative for its exact transaction
 // hash. Do not let an older, abandoned PREPARED intent with the same amount
 // make a historical rescan ambiguous.
 const confirmed=await db.prepare(`SELECT intent_id FROM mainnet_stake_intents WHERE chain_id=56
   AND lower(wallet_address)=lower(?) AND lower(custody_address)=lower(?) AND amount_atomic=?
   AND status='CONFIRMED' AND lower(payment_tx_hash)=lower(?) ORDER BY created_at LIMIT 2`)
  .bind(state.owner_wallet,state.custody_address,event.amount.toString(),event.txHash).all<{intent_id:string}>();
 if(confirmed.results.length>1)throw new Error('CUSTODY_STAKE_INTENT_AMBIGUOUS');
 if(confirmed.results.length===1)return confirmed.results[0].intent_id;
 const prepared=await db.prepare(`SELECT intent_id FROM mainnet_stake_intents WHERE chain_id=56
   AND lower(wallet_address)=lower(?) AND lower(custody_address)=lower(?) AND amount_atomic=?
   AND status='PREPARED' AND payment_tx_hash IS NULL ORDER BY created_at LIMIT 2`)
  .bind(state.owner_wallet,state.custody_address,event.amount.toString()).all<{intent_id:string}>();
 if(prepared.results.length>1)throw new Error('CUSTODY_STAKE_INTENT_AMBIGUOUS');
 return prepared.results[0]?.intent_id??null;
}

async function recordDetected(db:Database,env:WorkerEnv,state:ScanState,event:Detected,gasPrice:bigint){
 const collectionValue=envString(env,'MAINNET_CUSTODY_COLLECTION_ADDRESS');if(!collectionValue||!isAddress(collectionValue)||/^0x0{40}$/i.test(collectionValue))throw new Error('CUSTODY_COLLECTION_ADDRESS_INVALID');
 const collection=getAddress(collectionValue);
 const gasAddress=envString(env,'MAINNET_CUSTODY_GAS_ADDRESS');
 const maximumTopup=envString(env,'MAINNET_CUSTODY_GAS_TOPUP_WEI');
 if(!gasAddress||!isAddress(gasAddress)||/^0x0{40}$/i.test(gasAddress)||!maximumTopup)throw new Error('CUSTODY_GAS_CONFIG_INVALID');
 const owner=getAddress(state.owner_wallet),custody=getAddress(state.custody_address),source=getAddress(event.source),gasWallet=getAddress(gasAddress);
 if(event.kind==='TOKEN'&&event.tokenAddress?.toLowerCase()==='0x55d398326f99059ff775485246999027b3197955'){
  const intentId=await matchingStake(db,state,event);
  if(intentId&&source.toLowerCase()===owner.toLowerCase()){
   await recoverMainnetStakePayment(owner,normalizeMainnetStakeConfirmation(intentId,event.txHash));
   return;
  }
 }
 const topup=event.kind==='NATIVE'&&source.toLowerCase()===gasWallet.toLowerCase()?0n:await gasTopup(db,gasPrice,custody,maximumTopup);
 const supported=[envString(env,'MAINNET_PGR_ADDRESS'),envString(env,'MAINNET_SOV_ADDRESS')]
  .filter((address):address is string=>typeof address==='string'&&isAddress(address)).map(address=>getAddress(address));
 await recordCustodyReceipt(db,{ownerWallet:owner,custodyAddress:custody,sourceWallet:source,native:event.kind==='NATIVE',
  tokenAddress:event.tokenAddress,assetSymbol:event.symbol,amountAtomic:event.amount.toString(),depositTxHash:event.txHash,
  logIndex:event.logIndex,blockNumber:Number(event.blockNumber),blockHash:event.blockHash,stakeIntentId:null,
  collectionAddress:collection,gasWalletAddress:gasWallet,gasTopupAtomic:topup.toString(),supportedTokenAddresses:supported});
}

async function holdScanner(db:Database,state:ScanState,reason:string){
 await db.batch([
  db.prepare("UPDATE custody_scan_state SET status='HELD',lease_token=NULL,lease_expires_at=NULL,last_error=?,updated_at=? WHERE custody_address=?").bind(reason,Date.now(),state.custody_address),
  db.prepare("UPDATE custody_collection_control SET circuit_open=1,reason=?,updated_at=? WHERE singleton=1").bind(reason,Date.now()),
 ]);
}

export async function scanCustodyAddress(state:ScanState){
 const env=getCloudflareContext().env as unknown as WorkerEnv;if(!scannerEnabled(env))return {processed:false,reason:'disabled'};
 const db=serverDB();
 const tokenConfigs=[
  {address:getAddress('0x55d398326f99059ff775485246999027b3197955'),symbol:'USDT'},
  {address:envString(env,'MAINNET_PGR_ADDRESS'),symbol:'PGR'},
  {address:envString(env,'MAINNET_SOV_ADDRESS'),symbol:'SOV'},
 ].filter((entry):entry is {address:Address;symbol:string}=>typeof entry.address==='string'&&isAddress(entry.address)).map(entry=>({...entry,address:getAddress(entry.address)}));
 const custody=getAddress(state.custody_address),blockLimit=BigInt(positiveLimit(env,'MAINNET_CUSTODY_SCAN_MAX_BLOCKS',DEFAULT_BLOCK_LIMIT,100));
 let selected:{detected:Detected[];gasPrice:bigint;from:bigint;to:bigint;anchor:Hash}|null=null,reorg=false;
 const rpcFailures:string[]=[];
 for(const [rpcIndex,rpc] of scannerRpcUrls(env).entries()){
  let stage='client';
  try{
   const client=createPublicClient({chain:bsc,transport:http(rpc,{timeout:12000,retryCount:0,batch:{batchSize:10,wait:0}})});
   // Collapse the chain, head and reorg-anchor reads into one JSON-RPC batch.
   // Public endpoints commonly rate-limit several sequential control calls,
   // while keeping each block batch below their response-body ceiling.
   stage='control';
   const [chainId,latest,prior]=await Promise.all([
    client.getChainId(),client.getBlockNumber(),
    state.last_scanned_block!==null&&state.last_scanned_block_hash
     ?client.getBlock({blockNumber:BigInt(state.last_scanned_block)}):Promise.resolve(null),
   ]);
   if(chainId!==56)throw new Error('CUSTODY_RPC_CHAIN_MISMATCH');
   if(prior&&state.last_scanned_block_hash&&prior.hash?.toLowerCase()!==state.last_scanned_block_hash.toLowerCase()){reorg=true;continue;}
   if(latest+1n<CONFIRMATIONS)throw new Error('CUSTODY_CHAIN_TOO_SHORT');
   const finalized=latest-CONFIRMATIONS+1n,from=BigInt(state.next_block);if(from>finalized)return {processed:false,reason:'caught_up'};
   const to=from+blockLimit-1n>finalized?finalized:from+blockLimit-1n,detected:Detected[]=[];
   const tokenSymbols=new Map(tokenConfigs.map(token=>[token.address.toLowerCase(),token.symbol]));
   // Query only transfers into this custody address. Downloading every receipt
   // for every block exceeds common BSC RPC response limits and can stall the
   // cursor even when the relevant log set is tiny.
   stage='token-logs';
   const custodyTopic=`0x${custody.slice(2).toLowerCase().padStart(64,'0')}` as Hash;
   const tokenLogs=await client.request({method:'eth_getLogs',params:[{address:tokenConfigs.map(token=>token.address),
    fromBlock:toHex(from),toBlock:toHex(to),topics:[TRANSFER_TOPIC as Hash,null,custodyTopic]}]}) as RpcReceiptLog[];
   detected.push(...receiptTokenEvents([{logs:tokenLogs}],tokenSymbols,custody));
   const blockNumbers=Array.from({length:Number(to-from+1n)},(_,index)=>from+BigInt(index));
   for(let offset=0;offset<blockNumbers.length;offset+=10){stage=`blocks-${offset}`;
    const groups=await Promise.all(blockNumbers.slice(offset,offset+10).map(async blockNumber=>{
     const block=await client.getBlock({blockNumber,includeTransactions:true});return {block,blockNumber};
    }));
    for(const {block,blockNumber} of groups){if(!block.hash)throw new Error('CUSTODY_BLOCK_HASH_MISSING');
     for(const tx of block.transactions){if(typeof tx==='string'||!tx.to||tx.to.toLowerCase()!==custody.toLowerCase()||tx.value<=0n)continue;detected.push({kind:'NATIVE',tokenAddress:null,symbol:'BNB',source:getAddress(tx.from),amount:tx.value,txHash:tx.hash,logIndex:-1,blockNumber,blockHash:block.hash});}
    }
   }
   stage='anchor-gas';const [anchor,gasPrice]=await Promise.all([client.getBlock({blockNumber:to}),client.getGasPrice()]);if(!anchor.hash)throw new Error('CUSTODY_BLOCK_HASH_MISSING');
   // Re-read the range anchor before committing any event or cursor. A provider
   // that changed views during the request is rejected and the cursor stays put.
   stage='verify-anchor';const verified=await client.getBlock({blockNumber:to});if(verified.hash?.toLowerCase()!==anchor.hash.toLowerCase())throw new Error('CUSTODY_RPC_RANGE_CHANGED');
   selected={detected,gasPrice,from,to,anchor:anchor.hash};break;
  }catch(error){
   // Persist only provider position, scanner stage and the JavaScript error
   // class. Never persist the endpoint URL, request body or provider message;
   // a configured RPC URL may contain a credential in its path.
   const errorName=error instanceof Error?error.name.replace(/[^A-Za-z0-9_-]/g,'').slice(0,48):'UnknownError';
   rpcFailures.push(`${rpcIndex}-${stage}-${errorName||'Error'}`);
  }
 }
 if(!selected){if(reorg){await holdScanner(db,state,'CUSTODY_SCAN_REORG_DETECTED');return {processed:false,reason:'reorg_held'};}throw new Error(`CUSTODY_RPC_ALL_ENDPOINTS_FAILED:${rpcFailures.join(',')}`);}
 const {detected,gasPrice,from,to,anchor}=selected;
 detected.sort((a,b)=>Number(a.blockNumber-b.blockNumber)||a.logIndex-b.logIndex);
 for(const event of detected){
  if(event.blockNumber>BigInt(Number.MAX_SAFE_INTEGER))throw new Error('CUSTODY_BLOCK_NUMBER_OVERFLOW');
  await recordDetected(db,env,state,event,gasPrice);
 }
 const advanced=await db.prepare(`UPDATE custody_scan_state SET next_block=?,last_scanned_block=?,last_scanned_block_hash=?,
   lease_token=NULL,lease_expires_at=NULL,last_error=NULL,consecutive_failures=0,retry_after=NULL,updated_at=? WHERE custody_address=? AND lease_token=? AND status='ACTIVE'`)
  .bind(Number(to+1n),Number(to),anchor.toLowerCase(),Date.now(),state.custody_address,state.lease_token).run() as {meta?:{changes?:number}};
 if(advanced.meta?.changes!==1)throw new Error('CUSTODY_SCAN_LEASE_LOST');
 return {processed:true,events:detected.length,from:Number(from),to:Number(to)};
}

export async function pumpCustodyScanner(limit?:number){
 const env=getCloudflareContext().env as unknown as WorkerEnv;if(!scannerEnabled(env))return {processed:0};
 const db=serverDB(),now=Date.now(),addressLimit=limit??positiveLimit(env,'MAINNET_CUSTODY_SCAN_MAX_ADDRESSES',DEFAULT_ADDRESS_LIMIT,5);
 const publicMode=envString(env,'MAINNET_STAKE_PUBLIC_ENABLED')==='true';
 await db.prepare(`INSERT OR IGNORE INTO custody_scan_state(custody_address,owner_wallet,chain_id,next_block,status,updated_at)
   SELECT lower(deposit_address),lower(wallet_address),56,scan_block+1,'ACTIVE',? FROM wallet_custody_addresses
   WHERE chain_id=56 AND (?=1 OR lower(wallet_address)=lower(?))`).bind(now,publicMode?1:0,MAINNET_STAKE_TEST_WALLET).run();
 const candidates=await db.prepare(`SELECT custody_address FROM custody_scan_state WHERE status='ACTIVE'
   AND (?=1 OR lower(owner_wallet)=lower(?)) AND (retry_after IS NULL OR retry_after<=?) AND (lease_token IS NULL OR lease_expires_at<?)
   ORDER BY next_block,updated_at LIMIT ?`).bind(publicMode?1:0,MAINNET_STAKE_TEST_WALLET,now,now,addressLimit).all<{custody_address:string}>();
 let processed=0;
 for(const candidate of candidates.results){
  const lease=crypto.randomUUID(),expires=Date.now()+60_000;
  const state=await db.prepare(`UPDATE custody_scan_state SET lease_token=?,lease_expires_at=?,updated_at=?
    WHERE custody_address=? AND status='ACTIVE' AND (lease_token IS NULL OR lease_expires_at<?)
    RETURNING custody_address,owner_wallet,next_block,last_scanned_block,last_scanned_block_hash,status,lease_token,consecutive_failures,retry_after`)
   .bind(lease,expires,Date.now(),candidate.custody_address,Date.now()).first<ScanState&{lease_token:string}>();if(!state)continue;
  try{if((await scanCustodyAddress(state)).processed)processed++;}
  catch(error){const reason=error instanceof Error?error.message:'CUSTODY_SCAN_FAILED';
   if(/(?:AMBIGUOUS|REORG_CONFLICT|OWNER_ADDRESS_MISMATCH|REPLAY_CONFLICT)/.test(reason))await holdScanner(db,state,reason);
   else{const failures=Math.min((state.consecutive_failures??0)+1,7),retryAfter=Date.now()+Math.min(300_000,5_000*(2**(failures-1)));
    await db.prepare(`UPDATE custody_scan_state SET lease_token=NULL,lease_expires_at=NULL,last_error=?,consecutive_failures=?,retry_after=?,updated_at=?
    WHERE custody_address=? AND lease_token=?`).bind(reason,failures,retryAfter,Date.now(),state.custody_address,lease).run();}}
 }
 return {processed};
}
