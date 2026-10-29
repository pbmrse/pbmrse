import { getAddress, type Address } from 'viem';

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
function publicTestAddress(name:string){
 const value=process.env[name];
 return getAddress(value&&/^0x[0-9a-fA-F]{40}$/.test(value)?value:ZERO_ADDRESS);
}
export const MAINNET_STAKE_TEST_WALLET = publicTestAddress('MAINNET_STAKE_TEST_WALLET');
export const MAINNET_STAKE_TEST_REFERRER = publicTestAddress('MAINNET_STAKE_TEST_REFERRER');
export const MAINNET_STAKE_TEST_CUSTODY_ADDRESS = publicTestAddress('MAINNET_STAKE_TEST_CUSTODY_ADDRESS');
export const MAINNET_STAKE_TEST_AMOUNT_ATOMIC = '1000000000000000000';
export const MAINNET_PUBLIC_STAKE_MIN_ATOMIC = '500000000000000000';
export const MAINNET_STAKE_CANCEL_TEST_AMOUNT_ATOMIC = '500000000000000000';
export const MAINNET_STAKE_TEST_WINDOW_MS = 15 * 60 * 1000;
export type MainnetAcceptancePhase='STAKE'|'PGR_CLAIM'|'CANCEL_PARTIAL'|'CANCEL_MAX';
export type MainnetStakeAddressGrant={
 mode:'PBMRESERVES_STAKE_ADDRESS_ACCEPTANCE_V1';chainId:56;walletAddress:string;amountAtomic:string;
 referrerWallet:string;cycleId:string;windowStartMs:number;windowEndMs:number;
};

type GateEnv = Record<string, unknown>;

function envString(env: GateEnv, name: string): string | null {
  const value = Reflect.get(env, name);
  return typeof value === 'string' ? value : null;
}

function assertTestWallet(wallet: Address) {
  if (getAddress(wallet).toLowerCase() !== MAINNET_STAKE_TEST_WALLET.toLowerCase()) {
    throw new Error('MAINNET_STAKE_TEST_WALLET_REJECTED');
  }
}

export function publicMainnetStakingEnabled(env:GateEnv){
 return envString(env,'MAINNET_STAKE_PUBLIC_ENABLED')==='true';
}

/** Public reward claims remain independently gated per asset. SOV issuance is
 * additionally coupled to the mining settlement lifecycle by the claim path. */
export function publicMainnetPgrClaimsEnabled(env:GateEnv){
 return envString(env,'MAINNET_PGR_CLAIMS_PUBLIC_ENABLED')==='true';
}
export function publicMainnetSovClaimsEnabled(env:GateEnv){
 return envString(env,'MAINNET_SOV_CLAIMS_PUBLIC_ENABLED')==='true';
}

/** Production staking has no business maximum, but rejects dust below the
 * minimum executable collection amount. Amounts remain exact uint256 values. */
export function assertMainnetStakePreparationAccess(
 env:GateEnv,wallet:Address,request:{chainId:number;amountAtomic:string;referrerWallet:string|null},now=Date.now(),
){
 if(!publicMainnetStakingEnabled(env))return assertMainnetStakeTestPreparation(env,wallet,request,now);
 if(request.chainId!==56||!/^[1-9][0-9]{0,77}$/.test(request.amountAtomic)||
  BigInt(request.amountAtomic)<BigInt(MAINNET_PUBLIC_STAKE_MIN_ATOMIC)||BigInt(request.amountAtomic)>(1n<<256n)-1n)
  throw new Error('MAINNET_STAKE_TERMS_REJECTED');
 if(request.referrerWallet?.toLowerCase()===wallet.toLowerCase())throw new Error('SELF_REFERRAL_NOT_ALLOWED');
}

export function assertMainnetStakeRouteAccess(env:GateEnv,wallet:Address,action:'PREPARE'|'CONFIRM'|'CANCEL'){
 if(publicMainnetStakingEnabled(env)){
  return;
 }
 assertMainnetStakeTestRouteAccess(wallet,action);
}

export function mainnetStakeIntentId(wallet:Address,requestId:string,env:GateEnv){
 return publicMainnetStakingEnabled(env)?`stake:${wallet.toLowerCase()}:${requestId}`:mainnetStakeTestIntentId(wallet,env);
}

export function assertMainnetConfirmedIntentAccess(env:GateEnv,wallet:Address,intent:{
 intent_id:string;wallet_address:string;amount_atomic:string;referral_wallet:string|null;
}){
 if(!publicMainnetStakingEnabled(env))return assertMainnetStakeTestConfirmedIntent(wallet,intent);
 if(intent.wallet_address.toLowerCase()!==wallet.toLowerCase()||
  !intent.intent_id.toLowerCase().startsWith(`stake:${wallet.toLowerCase()}:`)||
  !/^[1-9][0-9]{0,77}$/.test(intent.amount_atomic)||
  BigInt(intent.amount_atomic)<BigInt(MAINNET_PUBLIC_STAKE_MIN_ATOMIC)||BigInt(intent.amount_atomic)>(1n<<256n)-1n)
  throw new Error('MAINNET_STAKE_INTENT_REJECTED');
}

function parseWindowTime(value: string | null): number {
  if (!value || !/^[1-9][0-9]{12}$/.test(value)) throw new Error('MAINNET_STAKE_TEST_WINDOW_LOCKED');
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error('MAINNET_STAKE_TEST_WINDOW_LOCKED');
  return parsed;
}

function testCycle(env:GateEnv){
  const cycle=envString(env,'MAINNET_STAKE_TEST_CYCLE_ID');
  if(!cycle||cycle==='disabled'||!/^[a-zA-Z0-9_-]{8,100}$/.test(cycle))throw new Error('MAINNET_STAKE_TEST_CYCLE_LOCKED');
  return cycle;
}

function activePhase(env:GateEnv,expected:MainnetAcceptancePhase,now=Date.now()){
 if(envString(env,'MAINNET_ACCEPTANCE_TEST_PHASE')!==expected)throw new Error('MAINNET_ACCEPTANCE_PHASE_LOCKED');
 if(envString(env,'MAINNET_STAKE_TEST_GATE_ENABLED')!=='true')throw new Error('MAINNET_STAKE_TEST_GATE_LOCKED');
 testCycle(env);
 const start=parseWindowTime(envString(env,'MAINNET_STAKE_TEST_WINDOW_START_MS'));
 const end=parseWindowTime(envString(env,'MAINNET_STAKE_TEST_WINDOW_END_MS'));
 if(end-start!==MAINNET_STAKE_TEST_WINDOW_MS||now<start||now>=end)throw new Error('MAINNET_STAKE_TEST_WINDOW_LOCKED');
}

/** New stake preparation is accepted only during one exact 15-minute window. */
export function assertMainnetStakeTestPreparation(
  env: GateEnv,
  wallet: Address,
  request: { chainId:number; amountAtomic:string; referrerWallet:string|null },
  now = Date.now(),
) {
  assertTestWallet(wallet);
  if (request.chainId !== 56 || request.amountAtomic !== MAINNET_STAKE_TEST_AMOUNT_ATOMIC ||
      request.referrerWallet?.toLowerCase() !== MAINNET_STAKE_TEST_REFERRER.toLowerCase()) {
    throw new Error('MAINNET_STAKE_TEST_TERMS_REJECTED');
  }
  if (envString(env, 'MAINNET_STAKE_TEST_GATE_ENABLED') !== 'true') {
    throw new Error('MAINNET_STAKE_TEST_GATE_LOCKED');
  }
  if(envString(env,'MAINNET_ACCEPTANCE_TEST_PHASE')!=='STAKE')throw new Error('MAINNET_ACCEPTANCE_PHASE_LOCKED');
  testCycle(env);
  const start = parseWindowTime(envString(env, 'MAINNET_STAKE_TEST_WINDOW_START_MS'));
  const end = parseWindowTime(envString(env, 'MAINNET_STAKE_TEST_WINDOW_END_MS'));
  if (end - start !== MAINNET_STAKE_TEST_WINDOW_MS || now < start || now >= end) {
    throw new Error('MAINNET_STAKE_TEST_WINDOW_LOCKED');
  }
}

/** The acceptance payment may only target the already verified immutable address. */
export function assertMainnetStakeTestCustodyAddress(address: Address) {
  if (getAddress(address).toLowerCase() !== MAINNET_STAKE_TEST_CUSTODY_ADDRESS.toLowerCase()) {
    throw new Error('MAINNET_STAKE_TEST_CUSTODY_REJECTED');
  }
}


export function assertMainnetCancellationTestAccess(env:GateEnv,wallet:Address,amountAtomic:string,now=Date.now()){
 assertTestWallet(wallet);
 if(amountAtomic!==MAINNET_STAKE_CANCEL_TEST_AMOUNT_ATOMIC)throw new Error('MAINNET_STAKE_TEST_TERMS_REJECTED');
 const phase=envString(env,'MAINNET_ACCEPTANCE_TEST_PHASE');
 if(phase!=='CANCEL_PARTIAL'&&phase!=='CANCEL_MAX')throw new Error('MAINNET_ACCEPTANCE_PHASE_LOCKED');
 activePhase(env,phase,now);
 return phase;
}

export function assertMainnetFixedAddressTestAccess(env:GateEnv,wallet:Address,now=Date.now()){
 assertTestWallet(wallet);activePhase(env,'STAKE',now);
}

/**
 * Public, non-secret acceptance envelope sent through the authenticated
 * Service Binding.  It lets the isolated Custody Signer re-check that a
 * bootstrap-locked derivation is only for the one approved address test.
 */
export function mainnetStakeAddressGrant(env:GateEnv,wallet:Address,now=Date.now()):MainnetStakeAddressGrant{
 assertMainnetFixedAddressTestAccess(env,wallet,now);
 const windowStartMs=parseWindowTime(envString(env,'MAINNET_STAKE_TEST_WINDOW_START_MS'));
 const windowEndMs=parseWindowTime(envString(env,'MAINNET_STAKE_TEST_WINDOW_END_MS'));
 return {
  mode:'PBMRESERVES_STAKE_ADDRESS_ACCEPTANCE_V1',chainId:56,
  walletAddress:MAINNET_STAKE_TEST_WALLET.toLowerCase(),amountAtomic:MAINNET_STAKE_TEST_AMOUNT_ATOMIC,
  referrerWallet:MAINNET_STAKE_TEST_REFERRER.toLowerCase(),cycleId:testCycle(env),windowStartMs,windowEndMs,
 };
}

export function assertMainnetCancellationTestPosition(phase:'CANCEL_PARTIAL'|'CANCEL_MAX',principalAtomic:string){
 if(!/^[1-9][0-9]*$/.test(principalAtomic))throw new Error('MAINNET_STAKE_TEST_POSITION_REJECTED');
 const principal=BigInt(principalAtomic),amount=BigInt(MAINNET_STAKE_CANCEL_TEST_AMOUNT_ATOMIC);
 if((phase==='CANCEL_PARTIAL'&&principal<=amount)||(phase==='CANCEL_MAX'&&principal!==amount))throw new Error('MAINNET_STAKE_TEST_POSITION_REJECTED');
}

export function assertMainnetPgrClaimTestAccess(env:GateEnv,wallet:Address,kind:'ISSUE'|'RECOVER'|'CONFIRM',asset:'PGR'|'SOV',now=Date.now()){
 if(getAddress(wallet).toLowerCase()!==MAINNET_STAKE_TEST_REFERRER.toLowerCase()||asset!=='PGR')throw new Error('MAINNET_REWARD_TEST_WALLET_REJECTED');
 if(kind==='ISSUE')activePhase(env,'PGR_CLAIM',now);
}

export function assertMainnetPgrClaimAccess(env:GateEnv,wallet:Address,kind:'ISSUE'|'RECOVER'|'CONFIRM',asset:'PGR'|'SOV',now=Date.now()){
 const publicPgr=publicMainnetPgrClaimsEnabled(env),publicSov=publicMainnetSovClaimsEnabled(env);
 if(asset==='PGR'&&publicPgr)return;
 if(asset==='SOV'&&publicSov)return;
 if(publicPgr||publicSov)throw new Error('MAINNET_REWARD_ASSET_REJECTED');
 assertMainnetPgrClaimTestAccess(env,wallet,kind,asset,now);
}

export function assertMainnetPgrClaimTestAmount(env:GateEnv,amountAtomic:string){
 const maximum=envString(env,'MAINNET_PGR_TEST_MAX_ATOMIC');
 if(!maximum||!/^[1-9][0-9]{0,77}$/.test(maximum)||!/^[1-9][0-9]{0,77}$/.test(amountAtomic)||BigInt(amountAtomic)>BigInt(maximum))throw new Error('MAINNET_REWARD_TEST_AMOUNT_REJECTED');
}

export function assertMainnetPgrClaimAmountAccess(env:GateEnv,amountAtomic:string,asset:'PGR'|'SOV'='PGR'){
 if((asset==='PGR'&&publicMainnetPgrClaimsEnabled(env))||(asset==='SOV'&&publicMainnetSovClaimsEnabled(env))){
  if(!/^[1-9][0-9]{0,77}$/.test(amountAtomic)||BigInt(amountAtomic)>(1n<<256n)-1n)throw new Error('MAINNET_REWARD_AMOUNT_REJECTED');
  return;
 }
 assertMainnetPgrClaimTestAmount(env,amountAtomic);
}

/** Every client request ID maps to one durable intent, preventing split or concurrent stakes. */
export function mainnetStakeTestIntentId(wallet: Address,env:GateEnv) {
  assertTestWallet(wallet);
  return `stake:${MAINNET_STAKE_TEST_WALLET.toLowerCase()}:${testCycle(env)}`;
}

export function assertMainnetStakeTestRouteAccess(wallet: Address, action: 'PREPARE'|'CONFIRM'|'CANCEL') {
  assertTestWallet(wallet);
  // CANCEL is permitted only for the same acceptance wallet. It is still
  // independently blocked by the master/lifecycle/refund gates, zero limits,
  // circuit breakers and Treasury signer bootstrap mode.
  if (!['PREPARE','CONFIRM','CANCEL'].includes(action)) throw new Error('MAINNET_STAKE_TEST_ACTION_REJECTED');
}

/** Confirmation may recover after the window closes, but only for the one fixed paid intent. */
export function assertMainnetStakeTestConfirmedIntent(wallet: Address, intent: {
  intent_id:string; wallet_address:string; amount_atomic:string; referral_wallet:string|null;
}) {
  assertTestWallet(wallet);
  if (!intent.intent_id.toLowerCase().startsWith(`stake:${MAINNET_STAKE_TEST_WALLET.toLowerCase()}:`) ||
      !/^stake:0x[0-9a-f]{40}:[a-zA-Z0-9_-]{8,100}$/i.test(intent.intent_id) ||
      intent.wallet_address.toLowerCase() !== MAINNET_STAKE_TEST_WALLET.toLowerCase() ||
      intent.amount_atomic !== MAINNET_STAKE_TEST_AMOUNT_ATOMIC ||
      intent.referral_wallet?.toLowerCase() !== MAINNET_STAKE_TEST_REFERRER.toLowerCase()) {
    throw new Error('MAINNET_STAKE_TEST_INTENT_REJECTED');
  }
}
