import {getCloudflareContext} from '@opennextjs/cloudflare';
import {decodeEventLog,keccak256,parseAbiItem,toBytes,type Address,type Hash,type Hex} from 'viem';
import {serverDB} from './server-db';
import {freshPosition,settleStaking,type Position} from './business-engine';
import {BUSINESS} from '@/config/business';
import {SIGNED_MINT_ABI,MINT_TYPES} from './mint-authorization';
import {MAINNET_RESERVE_POSITION,MAINNET_RESERVE_CLAIM,MAINNET_RESERVE_OPERATION,MAINNET_RENEW_CLAIM_RECOVERY} from './mainnet-claim-storage';
import {mainnetContracts} from './contracts-mainnet';
import {mainnetRewardClaimsEnabled,mainnetRewardClaimClients,mainnetReceiptClient} from './mainnet-reward-config';
import {sufficientlyConfirmed} from './deposit-credit';
import {mainnetMiningEnabled,settleMainnetMiningSource} from './mainnet-mining-settlement';
import {assertMainnetPgrClaimAmountAccess} from './mainnet-stake-test-gate';

type Asset='PGR'|'SOV';
type Claim={claim_id:Hex;wallet_address:Address;asset:Asset;amount_atomic:string;status:'RESERVED'|'MINTED';created_at:number;creation_block:number;tx_hash:Hash|null};

function dbNetworkGuard() {
  const env=getCloudflareContext().env;
  if(Reflect.get(env,'APP_NETWORK')!=='bsc-mainnet') throw new Error('Mainnet claim service requires APP_NETWORK=bsc-mainnet');
  if(!Reflect.get(env,'ADDRESS_DB_MAINNET')) throw new Error('Mainnet database is not configured');
}
function tokenFor(asset:Asset):Address { const c=mainnetContracts(); return asset==='PGR'?c.pgr:c.sov; }
export function mainnetIssuerConfigured():boolean { return mainnetRewardClaimsEnabled(); }
const AUTHORIZED_MINT_EVENT=parseAbiItem('event AuthorizedMint(address indexed recipient,bytes32 indexed claimId,uint256 amount)');

export async function confirmMainnetClaim(wallet:Address,id:Hex,hash:Hash) {
  dbNetworkGuard();
  const {client,assertChain}=mainnetReceiptClient(); await assertChain();
  const db=serverDB();
  const row=await db.prepare('SELECT * FROM reward_claims WHERE claim_id=? AND wallet_address=? AND chain_id=56').bind(id,wallet).first<Claim>();
  if(!row)throw new Error('Mainnet claim not found');
  assertMainnetPgrClaimAmountAccess(getCloudflareContext().env as Record<string,unknown>,row.amount_atomic,row.asset);
  if(row.status==='MINTED'){
    if(!row.tx_hash || row.tx_hash.toLowerCase()!==hash.toLowerCase())throw new Error('Mainnet claim already confirmed with another transaction');
    const operation=await db.prepare("SELECT operation_id FROM business_operations WHERE operation_id=? AND wallet_address=? AND chain_id=56 AND status='CONFIRMED' AND lower(tx_hash)=lower(?) AND operation_type=? AND asset=? AND amount_atomic=?").bind(id,wallet,row.tx_hash,row.asset==='PGR'?'STAKE_CLAIM':'MINING_CLAIM',row.asset,row.amount_atomic).first<{operation_id:string}>();
    if(!operation)throw new Error('Minted claim operation requires reconciliation');
    return {completed:true,chainId:56,claimId:id,txHash:row.tx_hash};
  }
  const receipt=await client.getTransactionReceipt({hash});
  if(receipt.status!=='success'||!receipt.blockHash||receipt.transactionHash.toLowerCase()!==hash.toLowerCase())throw new Error('Mainnet claim transaction failed or hash mismatch');
  const token=tokenFor(row.asset);let matchingMintEvents=0;
  for(const log of receipt.logs){
    if(log.address.toLowerCase()!==token.toLowerCase())continue;
    try{const event=decodeEventLog({abi:SIGNED_MINT_ABI,data:log.data,topics:log.topics});if(event.eventName==='AuthorizedMint'&&event.args.recipient.toLowerCase()===wallet.toLowerCase()&&event.args.claimId===id&&event.args.amount===BigInt(row.amount_atomic))matchingMintEvents++;}catch{}
  }
  if(matchingMintEvents!==1)throw new Error('Mainnet transaction must contain exactly one matching claim mint event');
  // Never replace an already-associated receipt with a different transaction.
  // A pending claim may be retried only against the same on-chain transaction.
  if(row.tx_hash && row.tx_hash.toLowerCase()!==hash.toLowerCase())throw new Error('Mainnet claim is associated with another transaction');
  const linked = await db.batch([
    db.prepare("UPDATE reward_claims SET tx_hash=? WHERE claim_id=? AND wallet_address=? AND chain_id=56 AND status='RESERVED' AND (tx_hash IS NULL OR lower(tx_hash)=lower(?))").bind(hash,id,wallet,hash),
  ]);
  if(linked[0]?.meta.changes!==1)throw new Error('Mainnet claim transaction association conflict; retry to verify confirmed operation');
  const latest=await client.getBlockNumber();
  if(latest<receipt.blockNumber||!sufficientlyConfirmed(latest,receipt.blockNumber))return {completed:false,chainId:56,claimId:id,txHash:hash,pending:true};
  if((await client.getBlock({blockNumber:receipt.blockNumber})).hash!==receipt.blockHash)throw new Error('Mainnet claim block changed');
  const transaction=await client.getTransaction({hash});
  if(transaction.hash.toLowerCase()!==hash.toLowerCase()||transaction.chainId!==56||!receipt.blockHash||transaction.blockHash!==receipt.blockHash||transaction.blockNumber!==receipt.blockNumber||transaction.to?.toLowerCase()!==token.toLowerCase()||transaction.value!==BigInt(0))throw new Error('Mainnet claim transaction target or block mismatch');
  const confirmed=await db.batch([
    db.prepare("UPDATE reward_claims SET status='MINTED',tx_hash=?,confirmed_at=? WHERE claim_id=? AND wallet_address=? AND chain_id=56 AND status='RESERVED' AND lower(tx_hash)=lower(?)").bind(hash,Date.now(),id,wallet,hash),
    db.prepare("UPDATE business_operations SET status='CONFIRMED',tx_hash=? WHERE operation_id=? AND chain_id=56 AND status='RESERVED' AND wallet_address=? AND operation_type=? AND asset=? AND amount_atomic=? AND EXISTS(SELECT 1 FROM reward_claims WHERE claim_id=? AND wallet_address=? AND chain_id=56 AND status='MINTED' AND lower(tx_hash)=lower(?) AND asset=? AND amount_atomic=?)").bind(hash,id,wallet,row.asset==='PGR'?'STAKE_CLAIM':'MINING_CLAIM',row.asset,row.amount_atomic,id,wallet,hash,row.asset,row.amount_atomic),
  ]);
  if(confirmed.length!==2 || confirmed.some(result=>result.meta.changes!==1)){
    const current=await db.prepare('SELECT status,tx_hash FROM reward_claims WHERE claim_id=? AND wallet_address=? AND chain_id=56').bind(id,wallet).first<{status:string;tx_hash:Hash|null}>();
    if(current?.status==='MINTED' && current.tx_hash?.toLowerCase()===hash.toLowerCase())throw new Error('Mainnet claim changed concurrently; retry to verify confirmed operation');
    throw new Error('Mainnet claim confirmation conflict');
  }
  return {completed:true,chainId:56,claimId:id,txHash:hash};
}

/**
 * Recovers the only mint transaction for a reserved claim when the wallet
 * broadcast succeeded but the browser never received its transaction hash.
 * The claim id is the on-chain replay guard, so an ambiguous result is held;
 * this path never creates or signs a replacement claim.
 */
export async function reconcileMainnetClaim(wallet:Address,id:Hex) {
  dbNetworkGuard();
  const {client,assertChain}=mainnetReceiptClient();await assertChain();
  const db=serverDB();
  const row=await db.prepare('SELECT * FROM reward_claims WHERE claim_id=? AND wallet_address=? AND chain_id=56').bind(id,wallet).first<Claim>();
  if(!row)throw new Error('Mainnet claim not found');
  assertMainnetPgrClaimAmountAccess(getCloudflareContext().env as Record<string,unknown>,row.amount_atomic,row.asset);
  if(row.tx_hash)return confirmMainnetClaim(wallet,id,row.tx_hash);
  if(row.status==='MINTED')throw new Error('Minted claim is missing its transaction hash; manual reconciliation required');
  const token=tokenFor(row.asset),latest=await client.getBlockNumber(),found=new Map<string,Hash>();
  const start=BigInt(row.creation_block);
  for(let from=start;from<=latest;from+=2000n){
    const to=from+1999n<latest?from+1999n:latest;
    const logs=await client.getLogs({address:token,event:AUTHORIZED_MINT_EVENT,args:{recipient:wallet,claimId:id},fromBlock:from,toBlock:to});
    for(const log of logs)if(log.args.amount===BigInt(row.amount_atomic)&&log.transactionHash)found.set(log.transactionHash.toLowerCase(),log.transactionHash);
  }
  if(found.size>1)throw new Error('Multiple claim transactions found; manual reconciliation required');
  const recovered=[...found.values()][0];
  if(recovered)return confirmMainnetClaim(wallet,id,recovered);
  const used=await client.readContract({address:token,abi:SIGNED_MINT_ABI,functionName:'usedClaims',args:[id]});
  if(used)throw new Error('Claim is used on-chain but its mint event was not found; manual reconciliation required');
  return {completed:false,chainId:56,claimId:id,pending:true,recovered:false};
}

export async function issueMainnetClaim(wallet:Address,asset:Asset) {
  dbNetworkGuard();
  if(!mainnetRewardClaimsEnabled()) throw new Error('Mainnet reward claims are disabled');
  // SOV issuance must settle the source mining cycles and referral tree first.
  if(asset==='SOV') {
    if(!mainnetMiningEnabled())throw new Error('Mainnet mining settlement is disabled');
    await settleMainnetMiningSource(wallet);
  }
  const {client,assertChain,authorize}=mainnetRewardClaimClients();await assertChain();
  const token=tokenFor(asset);
  const db=serverDB();
  let claim=await db.prepare("SELECT * FROM reward_claims WHERE wallet_address=? AND chain_id=56 AND asset=? AND status='RESERVED'").bind(wallet,asset).first<Claim>();
  if(!claim){
    const now=Date.now();
    await db.prepare('INSERT INTO business_positions(wallet_address,chain_id,version,position_json,updated_at) VALUES (?,56,0,?,?) ON CONFLICT DO NOTHING').bind(wallet,JSON.stringify(freshPosition(now)),now).run();
    const [row,ledger]=await Promise.all([
      db.prepare('SELECT position_json,version FROM business_positions WHERE wallet_address=? AND chain_id=56').bind(wallet).first<{position_json:string;version:number}>(),
      asset==='PGR'?db.prepare(`SELECT l.source_key,l.amount_atomic FROM wallet_ledger l LEFT JOIN mainnet_claim_ledger_sources s ON s.source_key=l.source_key
        WHERE lower(l.wallet_address)=lower(?) AND l.chain_id=56 AND l.asset='PGR' AND l.entry_type='STAKE_DIRECT_PGR' AND s.source_key IS NULL ORDER BY l.id`).bind(wallet).all<{source_key:string;amount_atomic:string}>():Promise.resolve({results:[]} as {results:{source_key:string;amount_atomic:string}[]}),
    ]);
    if(!row)throw new Error('No mainnet rewards available');
    const position=settleStaking(JSON.parse(row.position_json) as Position,now,BUSINESS.stakingDailyRateBps);
    const ledgerAmount=ledger.results.reduce((sum,item)=>sum+BigInt(item.amount_atomic),0n);
    const amount=BigInt(asset==='PGR'?position.stakePending:position.miningPending)+ledgerAmount;
    if(amount<=BigInt(0))throw new Error('No mainnet rewards available');
    assertMainnetPgrClaimAmountAccess(getCloudflareContext().env as Record<string,unknown>,amount.toString(),asset);
    if(asset==='PGR')position.stakePending='0';else position.miningPending='0';
    const id=keccak256(toBytes(crypto.randomUUID()));const block=await client.getBlockNumber();
    const reservation = await db.batch([
      db.prepare(MAINNET_RESERVE_POSITION).bind(JSON.stringify(position),now,id,wallet,row.version,wallet,asset),
      db.prepare(MAINNET_RESERVE_CLAIM).bind(id,asset,amount.toString(),now,Number(block),wallet,id),
      db.prepare(MAINNET_RESERVE_OPERATION).bind(asset==='PGR'?'STAKE_CLAIM':'MINING_CLAIM',id),
      ...ledger.results.map(item=>db.prepare(`INSERT INTO mainnet_claim_ledger_sources(claim_id,source_key,wallet_address,asset,amount_atomic,reserved_at)
        SELECT ?,source_key,wallet_address,'PGR',amount_atomic,? FROM wallet_ledger WHERE source_key=? AND lower(wallet_address)=lower(?)
        AND chain_id=56 AND asset='PGR' AND entry_type='STAKE_DIRECT_PGR'`).bind(id,now,item.source_key,wallet)),
    ]);
    if (reservation.length !== 3+ledger.results.length || reservation.some(result => result.meta.changes !== 1)) {
      throw new Error('Mainnet claim reservation conflict; retry claim');
    }
    claim=await db.prepare("SELECT * FROM reward_claims WHERE wallet_address=? AND chain_id=56 AND asset=? AND status='RESERVED'").bind(wallet,asset).first<Claim>();
    if(!claim)throw new Error('Mainnet account changed; retry claim');
  }
  if(claim.tx_hash)throw new Error('Mainnet claim transaction pending confirmation; reconcile before reissuing');
  // creation_block is intentionally immutable: it is the lower bound used to
  // recover a prior mint whose broadcast response was lost.
  const recovery=await db.batch([db.prepare(MAINNET_RENEW_CLAIM_RECOVERY).bind(claim.claim_id,wallet)]);
  if(recovery[0]?.meta.changes!==1)throw new Error('Mainnet claim recovery conflict; reconcile before reissuing');
  const authorization=await authorize(claim.claim_id);
  if(authorization.chainId!==56||authorization.token.toLowerCase()!==token.toLowerCase()||authorization.recipient.toLowerCase()!==wallet.toLowerCase()||authorization.amount!==claim.amount_atomic||authorization.claimId.toLowerCase()!==claim.claim_id.toLowerCase())throw new Error('Reward signer response does not match reserved claim');
  return {completed:false,...authorization};
}
