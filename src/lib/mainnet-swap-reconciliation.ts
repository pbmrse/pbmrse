import {getCloudflareContext} from '@opennextjs/cloudflare';
import {createPublicClient,decodeEventLog,getAddress,http,isAddress,parseAbi,toHex,type Address,type Hash} from 'viem';
import {bsc} from 'viem/chains';
import {serverDB,type Database} from './server-db';
import {mainnetContracts} from './contracts-mainnet';
import {mainnetSwapEnabled} from './mainnet-swap-config';
import {applyMainnetSwap} from './mainnet-swap';

const TRANSFER_ABI=parseAbi(['event Transfer(address indexed from,address indexed to,uint256 value)']);
const TRANSFER_TOPIC='0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef' as Hash;
const CONFIRMATIONS=12n,MAX_BLOCKS=100n,INITIAL_LOOKBACK=200n;
const PUBLIC_RPCS=['https://bsc-rpc.publicnode.com','https://1rpc.io/bnb'];
type WorkerEnv=Record<string,unknown>;
type ScanState={next_block:number;last_scanned_block:number|null;last_scanned_block_hash:string|null;lease_token:string|null;lease_expires_at:number|null;consecutive_failures:number;retry_after:number|null};
type Intent={intent_id:string;wallet_address:Address;asset:'PGR'|'SOV';amount_atomic:string;recipient_address:Address;created_at:number;tx_hash:string|null};
type RpcLog={address:string;topics:readonly Hash[];data:Hash;transactionHash:Hash;blockNumber:Hash;blockHash:Hash;logIndex:Hash};

const envString=(env:WorkerEnv,name:string)=>{const value=Reflect.get(env,name);return typeof value==='string'&&value?value:undefined;};
function rpcUrls(env:WorkerEnv){
 let configured:string[]=[];const raw=envString(env,'BSC_MAINNET_SCAN_RPC_URLS');
 if(raw){try{const value=JSON.parse(raw) as unknown;if(!Array.isArray(value)||value.some(item=>typeof item!=='string'))throw new Error();configured=value as string[];}catch{throw new Error('SWAP_SCAN_RPC_CONFIG_INVALID');}}
 const primary=envString(env,'BSC_MAINNET_RPC_URL');if(primary)configured.push(primary);
 const urls=[...new Set([...configured,...PUBLIC_RPCS])];
 if(!urls.length||urls.some(value=>{try{const url=new URL(value);return url.protocol!=='https:'||!!url.username||!!url.password;}catch{return true;}}))throw new Error('SWAP_SCAN_RPC_CONFIG_INVALID');
 return urls.slice(0,5);
}
function paymentRecipient(env:WorkerEnv){const value=envString(env,'MAINNET_SWAP_PAYMENT_RECIPIENT');if(!value||!isAddress(value)||/^0x0{40}$/i.test(value))throw new Error('SWAP_RECIPIENT_INVALID');return getAddress(value);}

async function expireUnpaid(db:Database,now:number){
 await db.prepare("UPDATE site_swap_intent_lifecycle SET state='EXPIRED',updated_at=? WHERE state='AWAITING_PAYMENT' AND expires_at<=?").bind(now,now).run();
}
async function reconcileRegistered(db:Database){
 const rows=await db.prepare("SELECT intent_id,wallet_address,asset,amount_atomic,recipient_address,created_at,tx_hash FROM site_swap_intents WHERE status='PREPARED' AND tx_hash IS NOT NULL ORDER BY created_at LIMIT 10").all<Intent>();
 let processed=0;
 for(const row of rows.results){const id=row.intent_id.split(':').at(-1);if(!id)throw new Error('SWAP_INTENT_ID_INVALID');
  await applyMainnetSwap(getAddress(row.wallet_address),{kind:'CONFIRM_SWAP',id,asset:row.asset,amountAtomic:row.amount_atomic,txHash:row.tx_hash!.toLowerCase() as Hash});processed++;
 }
 return processed;
}
async function matchingIntent(db:Database,asset:'PGR'|'SOV',from:Address,to:Address,amount:bigint,blockTimeMs:number){
 const rows=await db.prepare(`SELECT intent_id,wallet_address,asset,amount_atomic,recipient_address,created_at,tx_hash
  FROM site_swap_intents WHERE status='PREPARED' AND tx_hash IS NULL AND asset=? AND amount_atomic=?
  AND lower(wallet_address)=lower(?) AND lower(recipient_address)=lower(?) AND created_at<=? ORDER BY created_at LIMIT 2`)
  .bind(asset,amount.toString(),from,to,blockTimeMs+1000).all<Intent>();
 return rows.results[0]??null;
}
async function holdReorg(db:Database){await db.prepare("UPDATE site_swap_scan_state SET lease_token=NULL,lease_expires_at=NULL,retry_after=NULL,last_error='SWAP_SCAN_REORG_DETECTED',updated_at=? WHERE singleton=1").bind(Date.now()).run();}

async function scanRange(db:Database,state:ScanState,env:WorkerEnv){
 const contracts=mainnetContracts(),recipient=paymentRecipient(env),tokens=new Map([[contracts.pgr.toLowerCase(),'PGR' as const],[contracts.sov.toLowerCase(),'SOV' as const]]);
 const recipientTopic=`0x${recipient.slice(2).toLowerCase().padStart(64,'0')}` as Hash;
 const controlUrl=envString(env,'BSC_MAINNET_RPC_URL');if(!controlUrl)throw new Error('SWAP_CONTROL_RPC_MISSING');
 const controlClient=createPublicClient({chain:bsc,transport:http(controlUrl,{timeout:12000,retryCount:0})});
 const [chainId,latest,previous]=await Promise.all([controlClient.getChainId(),controlClient.getBlockNumber(),state.last_scanned_block!==null&&state.last_scanned_block_hash?controlClient.getBlock({blockNumber:BigInt(state.last_scanned_block)}):Promise.resolve(null)]);
 if(chainId!==56)throw new Error('SWAP_CONTROL_CHAIN_MISMATCH');
 if(previous&&state.last_scanned_block_hash&&previous.hash?.toLowerCase()!==state.last_scanned_block_hash.toLowerCase()){await holdReorg(db);return {processed:0,reason:'reorg'};}
 if(latest+1n<CONFIRMATIONS)throw new Error('SWAP_CHAIN_TOO_SHORT');
 const finalized=latest-CONFIRMATIONS+1n,from=state.next_block>0?BigInt(state.next_block):(finalized>INITIAL_LOOKBACK?finalized-INITIAL_LOOKBACK:0n);
 if(from>finalized){await db.prepare('UPDATE site_swap_scan_state SET lease_token=NULL,lease_expires_at=NULL,last_error=NULL,updated_at=? WHERE singleton=1 AND lease_token=?').bind(Date.now(),state.lease_token).run();return {processed:0,reason:'caught_up'};}
 let selected:{client:ReturnType<typeof createPublicClient>;from:bigint;to:bigint;anchor:Hash;logs:RpcLog[]}|null=null;
 const failures:string[]=[];
 for(const [index,url] of rpcUrls(env).entries())try{
  const client=createPublicClient({chain:bsc,transport:http(url,{timeout:12000,retryCount:0})});
  let to=from,logs:RpcLog[]|null=null,lastRangeError:unknown;
  // BSC public providers impose different eth_getLogs response/range limits.
  // Query one token address at a time because some providers reject the JSON-
  // RPC address-array form. Shrink the exact same cursor range until both
  // token queries succeed; never skip a block.
  for(const size of [MAX_BLOCKS,50n,20n,10n,5n,1n]){const candidate=from+size-1n>finalized?finalized:from+size-1n;
   try{const combined:RpcLog[]=[];for(const token of [contracts.pgr,contracts.sov])combined.push(...await client.request({method:'eth_getLogs',params:[{address:token,fromBlock:toHex(from),toBlock:toHex(candidate),topics:[TRANSFER_TOPIC,null,recipientTopic]}]}) as RpcLog[]);logs=combined;to=candidate;break;}
   catch(error){lastRangeError=error;}
  }
  if(!logs)throw lastRangeError??new Error('SWAP_SCAN_LOG_RANGE_FAILED');
  const anchor=await controlClient.getBlock({blockNumber:to});if(!anchor.hash)throw new Error('ANCHOR');
  const verified=await controlClient.getBlock({blockNumber:to});if(verified.hash?.toLowerCase()!==anchor.hash.toLowerCase())throw new Error('RANGE_CHANGED');
  selected={client:controlClient,from,to,anchor:anchor.hash,logs};break;
 }catch(error){failures.push(`${index}-${error instanceof Error?error.name:'Error'}`);}
 if(!selected)throw new Error(`SWAP_SCAN_RPC_ALL_FAILED:${failures.join(',')}`);
 const {client,from:scanFrom,to,anchor,logs}=selected,blockTimes=new Map<string,number>();let processed=0;
 logs.sort((a,b)=>Number(BigInt(a.blockNumber)-BigInt(b.blockNumber))||Number(BigInt(a.logIndex)-BigInt(b.logIndex)));
 for(const log of logs){const asset=tokens.get(log.address.toLowerCase());if(!asset)continue;
  let event;try{event=decodeEventLog({abi:TRANSFER_ABI,data:log.data,topics:log.topics as [Hash,...Hash[]]});}catch{throw new Error('SWAP_SCAN_LOG_INVALID');}
  if(event.eventName!=='Transfer'||event.args.to.toLowerCase()!==recipient.toLowerCase()||event.args.value<=0n)continue;
  const blockKey=log.blockNumber.toLowerCase();let blockTime=blockTimes.get(blockKey);if(blockTime===undefined){const block=await client.getBlock({blockNumber:BigInt(log.blockNumber)});if(block.hash?.toLowerCase()!==log.blockHash.toLowerCase())throw new Error('SWAP_SCAN_LOG_REORG');blockTime=Number(block.timestamp)*1000;blockTimes.set(blockKey,blockTime);}
  const intent=await matchingIntent(db,asset,getAddress(event.args.from),recipient,event.args.value,blockTime);if(!intent)continue;
  const id=intent.intent_id.split(':').at(-1);if(!id)throw new Error('SWAP_INTENT_ID_INVALID');
  await applyMainnetSwap(getAddress(intent.wallet_address),{kind:'CONFIRM_SWAP',id,asset,amountAtomic:intent.amount_atomic,txHash:log.transactionHash.toLowerCase() as Hash});processed++;
 }
 const advanced=await db.prepare(`UPDATE site_swap_scan_state SET next_block=?,last_scanned_block=?,last_scanned_block_hash=?,lease_token=NULL,lease_expires_at=NULL,
  consecutive_failures=0,retry_after=NULL,last_error=NULL,updated_at=? WHERE singleton=1 AND lease_token=?`).bind(Number(to+1n),Number(to),anchor.toLowerCase(),Date.now(),state.lease_token).run() as {meta?:{changes?:number}};
 if(advanced.meta?.changes!==1)throw new Error('SWAP_SCAN_LEASE_LOST');
 return {processed,from:Number(scanFrom),to:Number(to)};
}

export async function pumpMainnetSwapReconciliation(){
 const env=getCloudflareContext().env as unknown as WorkerEnv;if(!mainnetSwapEnabled())return {processed:0,reason:'disabled'};
 const db=serverDB(),now=Date.now();await expireUnpaid(db,now);
 const lease=crypto.randomUUID();
 const state=await db.prepare(`UPDATE site_swap_scan_state SET lease_token=?,lease_expires_at=?,updated_at=? WHERE singleton=1
  AND (lease_token IS NULL OR lease_expires_at<?)
  RETURNING next_block,last_scanned_block,last_scanned_block_hash,lease_token,lease_expires_at,consecutive_failures,retry_after`)
  .bind(lease,now+55_000,now,now).first<ScanState>();
 if(!state)return {processed:0,reason:'leased_or_backoff'};
 try{const registered=await reconcileRegistered(db);
  if(state.retry_after&&state.retry_after>now){await db.prepare('UPDATE site_swap_scan_state SET lease_token=NULL,lease_expires_at=NULL,updated_at=? WHERE singleton=1 AND lease_token=?').bind(Date.now(),lease).run();return {processed:registered,reason:'scan_backoff'};}
  const scanned=await scanRange(db,state,env);return {...scanned,processed:registered+scanned.processed};}
 catch(error){const failures=Math.min((state.consecutive_failures??0)+1,7),retryAfter=Date.now()+Math.min(300_000,5_000*(2**(failures-1))),reason=error instanceof Error?error.message:'SWAP_SCAN_FAILED';
  await db.prepare('UPDATE site_swap_scan_state SET lease_token=NULL,lease_expires_at=NULL,consecutive_failures=?,retry_after=?,last_error=?,updated_at=? WHERE singleton=1 AND lease_token=?').bind(failures,retryAfter,reason,Date.now(),lease).run();throw error;}
}
