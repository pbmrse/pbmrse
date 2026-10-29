import {formatUnits,type Address} from 'viem';
import {BUSINESS} from '@/config/business';
import {freshPosition,settle,type Position} from './business-engine';
import {mainnetBankWalletEnabled} from './mainnet-bank-config';
import {mainnetMiningEnabled,MINING_POLICY_STATUS} from './mainnet-mining-settlement';
import {mainnetIssuerConfigured} from './mainnet-reward-claims';
import {serverDB} from './server-db';
import {mainnetSwapEnabled} from './mainnet-swap-config';

/** Read-only chain-56 account snapshot. It never creates addresses or executes finance jobs. */
export async function businessSnapshot(wallet:Address){
 const db=serverDB(),owner=wallet.toLowerCase() as Address,now=Date.now();
 const [row,operations,claims,referral,rewards,pendingMiningPurchase,swapIntents,pendingSwap,ledger,directPgr,custody]=await Promise.all([
  db.prepare(`SELECT position_json FROM business_positions WHERE lower(wallet_address)=lower(?) AND chain_id=56
    ORDER BY version DESC,updated_at DESC LIMIT 1`).bind(owner).first<{position_json:string}>(),
  db.prepare("SELECT operation_id,operation_type,amount_atomic,asset,status,created_at,tx_hash,details_json FROM business_operations WHERE lower(wallet_address)=lower(?) AND chain_id=56 ORDER BY created_at DESC LIMIT 100").bind(owner).all<Record<string,unknown>>(),
  db.prepare("SELECT claim_id,asset,amount_atomic,status,created_at,tx_hash,confirmed_at FROM reward_claims WHERE lower(wallet_address)=lower(?) AND chain_id=56 ORDER BY created_at DESC LIMIT 100").bind(owner).all<{claim_id:string;asset:string;amount_atomic:string;status:string;created_at:number;tx_hash:string|null;confirmed_at:number|null}>(),
  db.prepare('SELECT parent_wallet FROM wallet_referrals WHERE lower(wallet_address)=lower(?)').bind(owner).first<{parent_wallet:Address|null}>(),
  db.prepare('SELECT reward_id,source_wallet,kind,generation,rate_bps,amount_atomic,from_at,to_at,created_at FROM business_rewards WHERE lower(wallet_address)=lower(?) ORDER BY created_at DESC LIMIT 100').bind(owner).all<Record<string,unknown>>(),
  db.prepare("SELECT intent_id,amount_atomic,recipient_address,created_at,tx_hash FROM mining_purchase_intents WHERE lower(wallet_address)=lower(?) AND status='PREPARED' ORDER BY created_at LIMIT 1").bind(owner).first<{intent_id:string;amount_atomic:string;recipient_address:Address;created_at:number;tx_hash:string|null}>(),
  db.prepare('SELECT s.intent_id,s.payout_mode,s.wallet_address,s.asset,s.amount_atomic,s.gross_usdt_atomic,s.fee_usdt_atomic,s.net_usdt_atomic,s.recipient_address,s.created_at,s.status,s.tx_hash,s.confirmed_at,p.status AS payout_status,p.tx_hash AS payout_tx_hash,p.confirmed_at AS payout_confirmed_at,p.last_error AS payout_last_error FROM site_swap_intents s LEFT JOIN site_swap_payouts p ON p.intent_id=s.intent_id WHERE lower(s.wallet_address)=lower(?) AND s.tx_hash IS NOT NULL ORDER BY s.created_at DESC LIMIT 100').bind(owner).all<Record<string,unknown>>(),
  Promise.resolve(null),
  db.prepare("SELECT amount_atomic FROM wallet_ledger WHERE lower(wallet_address)=lower(?) AND chain_id=56 AND asset='USDT'").bind(owner).all<{amount_atomic:string}>(),
  db.prepare(`SELECT l.amount_atomic FROM wallet_ledger l LEFT JOIN mainnet_claim_ledger_sources s ON s.source_key=l.source_key
    WHERE lower(l.wallet_address)=lower(?) AND l.chain_id=56 AND l.asset='PGR' AND l.entry_type='STAKE_DIRECT_PGR' AND s.source_key IS NULL`).bind(owner).all<{amount_atomic:string}>(),
  db.prepare('SELECT deposit_address FROM wallet_custody_addresses WHERE lower(wallet_address)=lower(?) AND chain_id=56').bind(owner).first<{deposit_address:Address}>(),
 ]);
 const position=row?JSON.parse(row.position_json) as Position:freshPosition(now);
 const preview=settle(position,Math.max(now,position.updatedAt),{stakingBps:BUSINESS.stakingDailyRateBps,miningBps:BUSINESS.miningDailyRateBps}).position;
 const pending=(asset:string)=>formatUnits(BigInt(claims.results.find(r=>r.asset===asset&&r.status==='RESERVED')?.amount_atomic??'0'),18);
 const available=ledger.results.reduce((sum,item)=>sum+BigInt(item.amount_atomic),0n);
 const claimableDirectPgr=directPgr.results.reduce((sum,item)=>sum+BigInt(item.amount_atomic),0n);
 const bankEnabled=mainnetBankWalletEnabled(owner),miningEnabled=mainnetMiningEnabled();
 return {swapEnabled:mainnetSwapEnabled(),swaps:swapIntents.results,pendingSwap:pendingSwap??null,
  pendingMiningPurchase,miningEnabled,miningPolicyStatus:MINING_POLICY_STATUS,miningRewards:rewards.results,walletAddress:owner,chainId:56,
  stake:{principal:formatUnits(BigInt(preview.stakePrincipal),18),pendingPgr:formatUnits(BigInt(preview.stakePending)+claimableDirectPgr,18)},
  mining:{investmentPgr:formatUnits(BigInt(preview.miningPgr),18),pendingSov:formatUnits(BigInt(preview.miningPending),18),earnedSov:formatUnits(BigInt(preview.miningEarned),18),capped:preview.miningCapped,cycle:preview.miningCycle},
  operations:operations.results,claimHistory:claims.results,claimsEnabled:mainnetIssuerConfigured(),reservedPgr:pending('PGR'),reservedSov:pending('SOV'),actionsEnabled:bankEnabled,
  referrerWallet:referral?.parent_wallet??null,availableUsdt:formatUnits(available,18),depositAddress:custody?.deposit_address??'0x0000000000000000000000000000000000000000',
  unavailableReason:bankEnabled?(miningEnabled?'':'Mining purchases paused'):'USDT banking is not open'};
}
