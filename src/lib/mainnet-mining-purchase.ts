import {getCloudflareContext} from '@opennextjs/cloudflare';
import {decodeEventLog,decodeFunctionData,getAddress,isAddress,parseAbi,type Address,type Hash} from 'viem';
import {serverDB} from './server-db';
import {mainnetContracts} from './contracts-mainnet';
import {mainnetReceiptClient} from './mainnet-reward-config';
import {mainnetMiningEnabled,settleMainnetMiningSource} from './mainnet-mining-settlement';
import {freshPosition,purchaseMining,settleStaking,type Position} from './business-engine';
import {BUSINESS} from '@/config/business';
import {MAINNET_TRACK_MINING_PAYMENT,MAINNET_APPLY_MINING_PURCHASE,MAINNET_CONFIRM_MINING_INTENT,MAINNET_RECORD_MINING_PURCHASE,MAINNET_REGISTER_MINER,MAINNET_ADVANCE_MINING_REVISION} from './mainnet-mining-storage';
import type {normalizeMiningAction} from './mining-action';

const TRANSFER_ABI=parseAbi(['event Transfer(address indexed from,address indexed to,uint256 value)','function transfer(address to,uint256 amount)']);
type Intent={intent_id:string;wallet_address:Address;amount_atomic:string;recipient_address:Address;referral_wallet:Address|null;created_at:number;status:'PREPARED'|'CONFIRMED';tx_hash:Hash|null};
function recipient():Address {
 const raw=Reflect.get(getCloudflareContext().env,'MAINNET_MINING_PAYMENT_RECIPIENT');
 if(typeof raw!=='string'||!isAddress(raw)||/^0x0{40}$/i.test(raw))throw new Error('Mainnet mining recipient is not configured');
 return getAddress(raw);
}
async function resolveReferralCandidate(wallet:Address,requested:Address|null){
 const db=serverDB();
 const current=await db.prepare('SELECT parent_wallet FROM wallet_referrals WHERE lower(wallet_address)=lower(?)').bind(wallet).first<{parent_wallet:Address|null}>();
 if(current?.parent_wallet){
  if(requested&&current.parent_wallet.toLowerCase()!==requested.toLowerCase())throw new Error('Your confirmed referrer cannot be changed');
  return {parent:current.parent_wallet.toLowerCase() as Address,bindingNeeded:false};
 }
 if(!requested)return {parent:null,bindingNeeded:!current};
 const parent=getAddress(requested).toLowerCase() as Address;
 if(parent===wallet.toLowerCase())throw new Error('Self-referral is not allowed');
 const [directs,cycle]=await Promise.all([
  db.prepare('SELECT COUNT(*) count FROM wallet_referrals WHERE lower(parent_wallet)=lower(?)').bind(parent).first<{count:number}>(),
  db.prepare(`WITH RECURSIVE ancestors(wallet) AS (
    SELECT ? UNION ALL SELECT r.parent_wallet FROM wallet_referrals r JOIN ancestors a
    ON lower(r.wallet_address)=lower(a.wallet) WHERE r.parent_wallet IS NOT NULL
  ) SELECT wallet FROM ancestors WHERE lower(wallet)=lower(?) LIMIT 1`).bind(parent,wallet).first<{wallet:string}>(),
 ]);
 if((directs?.count??0)>=BUSINESS.referralDirectLimit)throw new Error('Referral limit reached');
 if(cycle)throw new Error('Referral cycle rejected');
 return {parent,bindingNeeded:true};
}
export async function applyMainnetMiningPurchase(wallet:Address,action:ReturnType<typeof normalizeMiningAction>){
 if(Reflect.get(getCloudflareContext().env,'APP_NETWORK')!=='bsc-mainnet')throw new Error('Mainnet mining requires the mainnet Worker');
 if(!mainnetMiningEnabled())throw new Error('Mainnet mining is disabled');
 const db=serverDB(),id=`mining-purchase:${wallet}:${action.id}`;
 let intent=await db.prepare('SELECT * FROM mining_purchase_intents WHERE intent_id=? AND wallet_address=?').bind(id,wallet).first<Intent>();
 if(intent&&intent.amount_atomic!==action.amountAtomic)throw new Error('Mining request amount changed');
 if(intent&&(intent.referral_wallet?.toLowerCase()??null)!==(action.referrerWallet?.toLowerCase()??null))throw new Error('Mining request referral changed');
 if(intent&&intent.recipient_address.toLowerCase()!==recipient().toLowerCase())throw new Error('Mining recipient configuration changed');
 if(intent?.status==='CONFIRMED'){
  if(action.txHash&&(!intent.tx_hash||intent.tx_hash.toLowerCase()!==action.txHash.toLowerCase()))throw new Error('Mining request payment changed');
  if(!intent.tx_hash)throw new Error('Confirmed mining purchase is missing payment hash; reconciliation required');
  const operation=await db.prepare("SELECT operation_id FROM business_operations WHERE operation_id=? AND wallet_address=? AND chain_id=56 AND operation_type='MINING_PURCHASE' AND status='CONFIRMED' AND asset='PGR' AND amount_atomic=? AND lower(tx_hash)=lower(?)").bind(id,wallet,intent.amount_atomic,intent.tx_hash).first<{operation_id:string}>();
  if(!operation||!intent.tx_hash)throw new Error('Mining purchase confirmation record is missing');
  const registered=await db.prepare('SELECT wallet_address FROM mining_registry WHERE wallet_address=?').bind(wallet).first<{wallet_address:string}>();
  if(!registered)throw new Error('Confirmed mining purchase is missing miner registration; reconcile before retry');
  const position=await db.prepare('SELECT wallet_address FROM business_positions WHERE wallet_address=? AND chain_id=56').bind(wallet).first<{wallet_address:string}>();
  const referral=await db.prepare('SELECT parent_wallet FROM wallet_referrals WHERE lower(wallet_address)=lower(?)').bind(wallet).first<{parent_wallet:string|null}>();
  if(!position||(referral?.parent_wallet?.toLowerCase()??null)!==(intent.referral_wallet?.toLowerCase()??null))throw new Error('Confirmed mining purchase is missing account position or referral; reconcile before retry');
  return intent;
 }
 if(intent?.tx_hash&&action.txHash&&intent.tx_hash.toLowerCase()!==action.txHash.toLowerCase())throw new Error('Mining request payment changed');
 if(action.kind==='PREPARE_MINING'){
  if(intent)return intent;
  const now=Date.now();
  await settleMainnetMiningSource(wallet,now);
  const row=await db.prepare('SELECT position_json FROM business_positions WHERE wallet_address=? AND chain_id=56').bind(wallet).first<{position_json:string}>();
  purchaseMining(row?JSON.parse(row.position_json) as Position:freshPosition(now),BigInt(action.amountAtomic));
  const referral=await resolveReferralCandidate(wallet,action.referrerWallet);
  await db.prepare("INSERT INTO mining_purchase_intents(intent_id,wallet_address,amount_atomic,recipient_address,referral_wallet,created_at,status) VALUES (?,?,?,?,?,?,'PREPARED') ON CONFLICT DO NOTHING").bind(id,wallet,action.amountAtomic,recipient().toLowerCase(),referral.parent,now).first();
  intent=await db.prepare('SELECT * FROM mining_purchase_intents WHERE intent_id=? AND wallet_address=?').bind(id,wallet).first<Intent>();
  if(!intent)throw new Error('Mining purchase could not be prepared');
  if((intent.referral_wallet?.toLowerCase()??null)!==(referral.parent?.toLowerCase()??null))throw new Error('Mining order preparation conflict; reconcile before payment');
  return intent;
 }
 if(!intent||!action.txHash)throw new Error('Prepare the mining purchase first');
 if(intent.tx_hash&&intent.tx_hash.toLowerCase()!==action.txHash.toLowerCase())throw new Error('Mining request payment changed');
 const {client,assertChain}=mainnetReceiptClient();await assertChain();
 const receipt=await client.getTransactionReceipt({hash:action.txHash});
 if(receipt.status!=='success')throw new Error('Mining payment failed');
 const [block,latest,transaction]=await Promise.all([client.getBlock({blockNumber:receipt.blockNumber}),client.getBlockNumber(),client.getTransaction({hash:action.txHash})]);
 if(!receipt.blockHash||!transaction.blockHash||block.hash!==receipt.blockHash||transaction.blockHash!==receipt.blockHash||transaction.blockNumber!==receipt.blockNumber||receipt.transactionHash.toLowerCase()!==action.txHash.toLowerCase()||transaction.hash.toLowerCase()!==action.txHash.toLowerCase()||Number(block.timestamp)*1000+1000<intent.created_at)throw new Error('Mining payment does not match this request');
 const token=mainnetContracts().pgr.toLowerCase();
 if(transaction.chainId!==56||transaction.from.toLowerCase()!==wallet.toLowerCase()||transaction.to?.toLowerCase()!==token||transaction.value!==BigInt(0))throw new Error('Mining payment sender, token or native value mismatch');
 let transfer;
 try{transfer=decodeFunctionData({abi:TRANSFER_ABI,data:transaction.input});}catch{throw new Error('Mining payment transfer calldata invalid');}
 if(transfer.functionName!=='transfer'||String(transfer.args[0]).toLowerCase()!==intent.recipient_address.toLowerCase()||transfer.args[1]!==BigInt(intent.amount_atomic))throw new Error('Mining payment amount or recipient mismatch');
 let paid=BigInt(0);
 for(const log of receipt.logs){
  if(log.address.toLowerCase()!==token)continue;
  try{
   const event=decodeEventLog({abi:TRANSFER_ABI,data:log.data,topics:log.topics});
   if(event.args.from.toLowerCase()===wallet.toLowerCase()&&event.args.to.toLowerCase()===intent.recipient_address.toLowerCase())paid+=event.args.value;
  }catch{/* Ignore non-Transfer events. */}
 }
 if(paid!==BigInt(intent.amount_atomic))throw new Error('Mining payment amount or recipient mismatch');
 const existingPayment=await db.prepare('SELECT intent_id FROM mining_purchase_intents WHERE lower(tx_hash)=lower(?) AND intent_id<>?').bind(action.txHash,id).first<{intent_id:string}>();
 if(existingPayment)throw new Error('Mining payment already assigned to another purchase');
 await db.prepare(MAINNET_TRACK_MINING_PAYMENT).bind(action.txHash,id,wallet,action.txHash).first();
 intent=await db.prepare('SELECT * FROM mining_purchase_intents WHERE intent_id=? AND wallet_address=?').bind(id,wallet).first<Intent>();
 if(!intent||!intent.tx_hash||intent.tx_hash.toLowerCase()!==action.txHash.toLowerCase())throw new Error('Mining request payment changed');
 if(intent.status==='CONFIRMED')throw new Error('Mining purchase confirmed concurrently; retry to verify credited records');
 if(latest<receipt.blockNumber||latest-receipt.blockNumber+BigInt(1)<BigInt(12))return intent;
 const now=Date.now();await settleMainnetMiningSource(wallet,now);
 await db.prepare('INSERT INTO business_positions(wallet_address,chain_id,position_json,updated_at) VALUES (?,56,?,?) ON CONFLICT DO NOTHING').bind(wallet,JSON.stringify(freshPosition(now)),now).first();
 const row=await db.prepare('SELECT position_json,version FROM business_positions WHERE wallet_address=? AND chain_id=56').bind(wallet).first<{position_json:string;version:number}>();
 if(!row)throw new Error('Mining account unavailable');
 const position=purchaseMining(settleStaking(JSON.parse(row.position_json) as Position,now,BUSINESS.stakingDailyRateBps),paid,now);
 position.miningUpdatedAt=now;
 const referral=await resolveReferralCandidate(wallet,intent.referral_wallet);
 const referralWrite=referral.parent?
  (referral.bindingNeeded?db.prepare(`INSERT INTO wallet_referrals(wallet_address,parent_wallet,confirmed_at)
    SELECT ?,?,? WHERE (SELECT COUNT(*) FROM wallet_referrals WHERE lower(parent_wallet)=lower(?))<?
    AND NOT EXISTS(WITH RECURSIVE ancestors(wallet) AS (
      SELECT ? UNION ALL SELECT r.parent_wallet FROM wallet_referrals r JOIN ancestors a
      ON lower(r.wallet_address)=lower(a.wallet) WHERE r.parent_wallet IS NOT NULL
    ) SELECT 1 FROM ancestors WHERE lower(wallet)=lower(?))
    ON CONFLICT(wallet_address) DO UPDATE SET parent_wallet=excluded.parent_wallet,confirmed_at=excluded.confirmed_at
    WHERE wallet_referrals.parent_wallet IS NULL OR lower(wallet_referrals.parent_wallet)=lower(excluded.parent_wallet)`)
    .bind(wallet,referral.parent,now,referral.parent,BUSINESS.referralDirectLimit,referral.parent,wallet):
   db.prepare(`INSERT INTO wallet_referrals(wallet_address,parent_wallet,confirmed_at) VALUES (?,?,?)
    ON CONFLICT(wallet_address) DO UPDATE SET confirmed_at=wallet_referrals.confirmed_at
    WHERE lower(wallet_referrals.parent_wallet)=lower(excluded.parent_wallet)`).bind(wallet,referral.parent,now)):
  db.prepare(`INSERT INTO wallet_referrals(wallet_address,parent_wallet,confirmed_at) VALUES (?,NULL,?)
    ON CONFLICT(wallet_address) DO UPDATE SET confirmed_at=wallet_referrals.confirmed_at
    WHERE wallet_referrals.parent_wallet IS NULL`).bind(wallet,now);
 const referralKey=referral.parent?.toLowerCase()??'';
 const purchaseWrites=await db.batch([
  referralWrite,
  db.prepare(MAINNET_APPLY_MINING_PURCHASE).bind(JSON.stringify(position),now,id,wallet,row.version,id,id,action.txHash,referralKey,referralKey,action.txHash,id),
  db.prepare(MAINNET_CONFIRM_MINING_INTENT).bind(action.txHash,now,id,action.txHash,wallet,id),
  db.prepare(MAINNET_RECORD_MINING_PURCHASE).bind(JSON.stringify({recipient:intent.recipient_address}),id),
  db.prepare(MAINNET_REGISTER_MINER).bind(id),
  db.prepare(MAINNET_ADVANCE_MINING_REVISION).bind(wallet,id),
 ]);
 if(purchaseWrites.length!==6||purchaseWrites.some((result,index)=>!result.meta||(index===4 ? ![0,1].includes(result.meta.changes) : result.meta.changes!==1)))throw new Error('Mining purchase batch requires reconciliation; do not replay the payment');
 const confirmed=await db.prepare('SELECT * FROM mining_purchase_intents WHERE intent_id=? AND wallet_address=?').bind(id,wallet).first<Intent>();
 if(confirmed?.status!=='CONFIRMED'||!confirmed.tx_hash||confirmed.tx_hash.toLowerCase()!==action.txHash.toLowerCase())throw new Error('Mining payment confirmation conflict; reconcile the same transaction');
 const [operation,applied,registered]=await Promise.all([
  db.prepare("SELECT operation_id FROM business_operations WHERE operation_id=? AND wallet_address=? AND chain_id=56 AND operation_type='MINING_PURCHASE' AND status='CONFIRMED' AND asset='PGR' AND amount_atomic=? AND lower(tx_hash)=lower(?)").bind(id,wallet,intent.amount_atomic,action.txHash).first<{operation_id:string}>(),
  db.prepare('SELECT last_operation_id FROM business_positions WHERE wallet_address=? AND chain_id=56').bind(wallet).first<{last_operation_id:string|null}>(),
  db.prepare('SELECT wallet_address FROM mining_registry WHERE wallet_address=?').bind(wallet).first<{wallet_address:string}>(),
 ]);
 if(!operation||applied?.last_operation_id!==id||!registered)throw new Error('Mining purchase records require reconciliation; do not replay the payment');
 return confirmed;
}
