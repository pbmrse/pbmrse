import {getCloudflareContext} from '@opennextjs/cloudflare';
import {decodeEventLog,decodeFunctionData,getAddress,isAddress,parseAbi,type Address} from 'viem';
import {serverDB} from './server-db';
import {mainnetContracts} from './contracts-mainnet';
import {mainnetSwapEnabled} from './mainnet-swap-config';
import {mainnetReceiptClient} from './mainnet-reward-config';
import {swapQuote,type normalizeSwapAction} from './swap-action';
import {treasuryJobFingerprint} from './treasury-job-policy';

const TOKEN_ABI=parseAbi(['event Transfer(address indexed from,address indexed to,uint256 value)','function transfer(address to,uint256 amount)']);
type Intent={intent_id:string;wallet_address:Address;asset:'PGR'|'SOV';amount_atomic:string;gross_usdt_atomic:string;fee_usdt_atomic:string;net_usdt_atomic:string;recipient_address:Address;created_at:number;status:'PREPARED'|'CONFIRMED';payout_mode:'WALLET';tx_hash:string|null;confirmed_at:number|null};
function payoutSender():Address{
 const raw=Reflect.get(getCloudflareContext().env,'MAINNET_TREASURY_ADDRESS');
 if(typeof raw!=='string'||!isAddress(raw)||/^0x0{40}$/i.test(raw))throw new Error('Mainnet treasury address is not configured');
 return getAddress(raw);
}
function recipient():Address{
 const raw=Reflect.get(getCloudflareContext().env,'MAINNET_SWAP_PAYMENT_RECIPIENT');
 if(typeof raw!=='string'||!isAddress(raw)||/^0x0{40}$/i.test(raw))throw new Error('Mainnet swap recipient is not configured');
 return getAddress(raw);
}
export async function applyMainnetSwap(wallet:Address,action:ReturnType<typeof normalizeSwapAction>){
 const env=getCloudflareContext().env;
 if(!mainnetSwapEnabled())throw new Error('Mainnet swap is disabled or configuration is incomplete');
 const configuredSwapTreasury=Reflect.get(env,'MAINNET_SWAP_TREASURY_ADDRESS');
 if(typeof configuredSwapTreasury!=='string'||!isAddress(configuredSwapTreasury)||
    /^0x0{40}$/i.test(configuredSwapTreasury)||
    configuredSwapTreasury.toLowerCase()!==payoutSender().toLowerCase())
  throw new Error('Mainnet Swap treasury must match the actual USDT payout sender');
 const treasury=payoutSender();
 const owner=getAddress(wallet).toLowerCase() as Address;
 const db=serverDB(),id=`swap:${owner}:${action.id}`;
 const read=()=>db.prepare('SELECT * FROM site_swap_intents WHERE intent_id=? AND lower(wallet_address)=lower(?)').bind(id,owner).first<Intent>();
 let intent=await read();
 if(intent&&(intent.asset!==action.asset||intent.amount_atomic!==action.amountAtomic))throw new Error('Original swap asset or amount changed');
 if(intent&&intent.recipient_address.toLowerCase()!==recipient().toLowerCase())throw new Error('Swap recipient configuration changed');
 if(intent){
  const gross=BigInt(intent.amount_atomic)/BigInt(intent.asset==='PGR'?2:1);
  const fee=BigInt(intent.fee_usdt_atomic),net=BigInt(intent.net_usdt_atomic);
  // Preserve the original accepted fee when configuration changes after PREPARE.
  if(intent.gross_usdt_atomic!==gross.toString()||fee<0n||net<=0n||fee+net!==gross||intent.payout_mode!=='WALLET')throw new Error('Saved swap quote or payout mode requires reconciliation');
 }
 if(intent?.tx_hash&&action.txHash&&intent.tx_hash.toLowerCase()!==action.txHash.toLowerCase())throw new Error('Original swap payment changed');
 if(intent?.status==='CONFIRMED'){
  if(action.kind!=='PREPARE_SWAP'&&action.txHash&&(!intent.tx_hash||intent.tx_hash.toLowerCase()!==action.txHash.toLowerCase()))throw new Error('Confirmed swap payment hash mismatch');
  if(!intent.tx_hash)throw new Error('Confirmed swap is missing payment hash; reconciliation required');
  const [operation,payout,queue]=await Promise.all([
   db.prepare("SELECT operation_id FROM business_operations WHERE operation_id=? AND wallet_address=? AND chain_id=56 AND operation_type='SWAP' AND lower(tx_hash)=lower(?)").bind(id,owner,intent.tx_hash).first<{operation_id:string}>(),
   db.prepare("SELECT intent_id FROM site_swap_payouts WHERE intent_id=? AND wallet_address=? AND chain_id=56 AND amount_atomic=? AND lower(usdt_token_address)=lower(?)").bind(id,owner,intent.net_usdt_atomic,mainnetContracts().usdt).first<{intent_id:string}>(),
   db.prepare("SELECT job_id FROM bank_transaction_queue WHERE job_id=? AND operation_id=? AND owner_wallet=? AND chain_id=56 AND asset='USDT' AND amount_atomic=? AND lower(sender_address)=lower(?) AND lower(recipient_address)=lower(?)").bind('swap-payout:'+id,id,owner,intent.net_usdt_atomic,treasury,owner).first<{job_id:string}>()
  ]);
  if(!operation||!payout||!queue)throw new Error('Confirmed swap payout records require reconciliation');
  return intent;
 }
 const {client,assertChain}=mainnetReceiptClient();await assertChain();
 const contracts=mainnetContracts();
 const token=contracts[action.asset==='PGR'?'pgr':'sov'];
 if(action.kind==='PREPARE_SWAP'){
  if(intent)return intent;
  const balanceAbi=parseAbi(['function balanceOf(address) view returns (uint256)']);
  const balance=await client.readContract({address:token,abi:balanceAbi,functionName:'balanceOf',args:[owner]});
  if(balance<BigInt(action.amountAtomic))throw new Error('Insufficient swap token balance');
  const q=swapQuote(action.asset,BigInt(action.amountAtomic)),now=Date.now();
  // A verified token payment creates a durable USDT liability. Treasury
  // liquidity is checked by the isolated payout executor; temporary shortage
  // must delay the payout, never discard or block an otherwise valid payment.
  await db.batch([
   db.prepare("INSERT INTO site_swap_intents(intent_id,wallet_address,asset,amount_atomic,gross_usdt_atomic,fee_usdt_atomic,net_usdt_atomic,recipient_address,created_at,status,payout_mode) VALUES (?,?,?,?,?,?,?,?,?,'PREPARED','WALLET') ON CONFLICT DO NOTHING").bind(id,owner,action.asset,action.amountAtomic,q.gross.toString(),q.fee.toString(),q.net.toString(),recipient().toLowerCase(),now),
   db.prepare("INSERT INTO site_swap_intent_lifecycle(intent_id,state,expires_at,updated_at) SELECT intent_id,'AWAITING_PAYMENT',?+900000,? FROM site_swap_intents WHERE intent_id=? ON CONFLICT(intent_id) DO NOTHING").bind(now,now,id),
  ]);
  intent=await read();if(!intent)throw new Error('Swap order could not be prepared');
  if(intent.asset!==action.asset||intent.amount_atomic!==action.amountAtomic||intent.recipient_address.toLowerCase()!==recipient().toLowerCase()||intent.gross_usdt_atomic!==q.gross.toString()||BigInt(intent.fee_usdt_atomic)<0n||BigInt(intent.net_usdt_atomic)<=0n||BigInt(intent.fee_usdt_atomic)+BigInt(intent.net_usdt_atomic)!==q.gross||intent.payout_mode!=='WALLET')throw new Error('Swap order preparation conflict; reconcile before payment');
  return intent;
 }
 if(!intent||!action.txHash)throw new Error('Prepare the swap first');
 const hash=action.txHash.toLowerCase() as `0x${string}`;
 const receipt=await client.getTransactionReceipt({hash});
 if(receipt.status!=='success'||!receipt.blockHash)throw new Error('Swap payment failed or not included in a block');
 const [transaction,block,latest]=await Promise.all([client.getTransaction({hash}),client.getBlock({blockNumber:receipt.blockNumber}),client.getBlockNumber()]);
 if(transaction.chainId!==56||block.hash!==receipt.blockHash||transaction.blockHash!==receipt.blockHash||transaction.blockNumber!==receipt.blockNumber||receipt.transactionHash.toLowerCase()!==hash.toLowerCase()||transaction.hash.toLowerCase()!==hash.toLowerCase()||Number(block.timestamp)*1000+1000<intent.created_at)throw new Error('Swap payment does not match this request');
 if(transaction.from.toLowerCase()!==wallet.toLowerCase()||transaction.to?.toLowerCase()!==token.toLowerCase())throw new Error('Swap sender or token mismatch');
 if(transaction.value!==BigInt(0))throw new Error('Swap ERC20 payment must not transfer native BNB');
 let call;try{call=decodeFunctionData({abi:TOKEN_ABI,data:transaction.input});}catch{throw new Error('Swap transfer calldata invalid');}
 if(call.functionName!=='transfer'||String(call.args[0]).toLowerCase()!==intent.recipient_address.toLowerCase()||call.args[1]!==BigInt(intent.amount_atomic))throw new Error('Swap payment amount or recipient mismatch');
 let paid=BigInt(0), matchingTransfers=0;
 for(const log of receipt.logs){if(log.address.toLowerCase()!==token.toLowerCase())continue;try{const event=decodeEventLog({abi:TOKEN_ABI,data:log.data,topics:log.topics});if(event.args.from.toLowerCase()===wallet.toLowerCase()&&event.args.to.toLowerCase()===intent.recipient_address.toLowerCase()){paid+=event.args.value;matchingTransfers++;}}catch{/* ignore other logs */}}
 if(matchingTransfers!==1||paid!==BigInt(intent.amount_atomic))throw new Error('Swap payment amount or recipient mismatch');
 await db.batch([
  db.prepare("UPDATE site_swap_intents SET tx_hash=? WHERE intent_id=? AND wallet_address=? AND status='PREPARED' AND (tx_hash IS NULL OR lower(tx_hash)=lower(?))").bind(hash,id,owner,hash),
  db.prepare("UPDATE site_swap_intent_lifecycle SET state='PAYMENT_DETECTED',updated_at=?,last_error=NULL WHERE intent_id=? AND state<>'CONFIRMED'").bind(Date.now(),id),
 ]);
 intent=await read();if(!intent||intent.tx_hash?.toLowerCase()!==hash)throw new Error('Original swap payment changed');
 if(intent.status==='CONFIRMED')throw new Error('Swap confirmation changed concurrently; retry to verify payout records');
 if(latest<receipt.blockNumber||latest-receipt.blockNumber+BigInt(1)<BigInt(12))return intent;
 const now=Date.now(),confirmation=crypto.randomUUID(),details=JSON.stringify({recipient:intent.recipient_address,grossUsdtAtomic:intent.gross_usdt_atomic,feeUsdtAtomic:intent.fee_usdt_atomic,netUsdtAtomic:intent.net_usdt_atomic});
 const payoutJobId='swap-payout:'+id;
 const payoutFingerprint=treasuryJobFingerprint({job_id:payoutJobId,operation_id:id,owner_wallet:owner,sender_kind:'TREASURY',sender_address:treasury,recipient_address:owner,chain_id:56,asset:'USDT',amount_atomic:intent.net_usdt_atomic,created_at:now});
 const applied=await db.batch([
  db.prepare("UPDATE site_swap_intents SET status='CONFIRMED',confirmed_at=?,confirmation_key=? WHERE intent_id=? AND status='PREPARED' AND tx_hash=?").bind(now,confirmation,id,hash),
  db.prepare("INSERT INTO business_operations(operation_id,wallet_address,chain_id,operation_type,amount_atomic,asset,status,created_at,tx_hash,details_json) SELECT intent_id,wallet_address,56,'SWAP',amount_atomic,asset,'QUEUED',?,tx_hash,? FROM site_swap_intents WHERE intent_id=? AND confirmation_key=?").bind(now,details,id,confirmation),
  db.prepare("INSERT INTO site_swap_payouts(intent_id,wallet_address,chain_id,usdt_token_address,amount_atomic,status,created_at,updated_at) SELECT intent_id,wallet_address,56,?,net_usdt_atomic,'READY',?,? FROM site_swap_intents WHERE intent_id=? AND confirmation_key=?").bind(contracts.usdt.toLowerCase(),now,now,id,confirmation),
  db.prepare("INSERT INTO bank_transaction_queue(job_id,operation_id,owner_wallet,sender_kind,sender_address,recipient_address,chain_id,asset,amount_atomic,status,created_at,job_fingerprint) SELECT 'swap-payout:'||intent_id,intent_id,wallet_address,'TREASURY',?,wallet_address,56,'USDT',net_usdt_atomic,'PENDING',?,? FROM site_swap_intents WHERE intent_id=? AND confirmation_key=?").bind(treasury.toLowerCase(),now,payoutFingerprint,id,confirmation)
  ,db.prepare("UPDATE site_swap_intent_lifecycle SET state='CONFIRMED',updated_at=?,last_error=NULL WHERE intent_id=?").bind(now,id)
 ]);
 if(applied.length!==5||applied.some(row=>!row.meta||row.meta.changes!==1))throw new Error('Swap confirmation records require reconciliation');
 intent=await read();if(intent?.status!=='CONFIRMED')throw new Error('Swap confirmation pending; retry original payment');
 return intent;
}
