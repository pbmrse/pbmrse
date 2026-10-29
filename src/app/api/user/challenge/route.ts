import {normalizeMiningAction} from '@/lib/mining-action';
import {normalizeBankAction} from '@/lib/bank-action';
import { formatUnits, getAddress, isAddress } from 'viem';
import { serverDB } from '@/lib/server-db';
import { getCloudflareContext } from '@opennextjs/cloudflare';
import { normalizeMainnetStakeCancellation } from '@/lib/mainnet-stake-cancellation';
import { normalizeMainnetStakePreparation } from '@/lib/mainnet-stake-prepare';
import { normalizeMainnetStakeConfirmation } from '@/lib/mainnet-stake-confirmation';
import { mainnetSwapPurpose, normalizeSwapAction } from '@/lib/swap-action';
import { normalizeMainnetClaimAction } from '@/lib/mainnet-claim-action';
import { mainnetStakeCancellationReadiness } from '@/lib/mainnet-stake-readiness';
import { assertMainnetCancellationTestAccess, assertMainnetFixedAddressTestAccess, assertMainnetPgrClaimAccess, assertMainnetStakeRouteAccess, publicMainnetStakingEnabled } from '@/lib/mainnet-stake-test-gate';

export async function POST(request: Request) {
  try {
    const body = await request.json() as { walletAddress?: string; purpose?: string; action?:unknown; requestId?:unknown; amountAtomic?:unknown; referrerWallet?:unknown; intentId?:unknown; txHash?:unknown };
    const wallet = body.walletAddress?.trim().toLowerCase();
    if (!wallet || !isAddress(wallet) || !['account','business','claim-PGR','claim-SOV','claim-confirm','mainnet-claim','deposit-address','mainnet-deposit-address','mainnet-stake-prepare','mainnet-stake-confirm','mainnet-stake-status','mainnet-stake-position','mainnet-stake-cancel','mainnet-swap','bank-action','mining-action'].includes(body.purpose || '')) return Response.json({ error: 'Invalid wallet challenge request' }, { status: 400 });
    let purpose=body.purpose!;let actionText='';
    if(purpose==='mainnet-stake-prepare'||purpose==='mainnet-stake-confirm'||purpose==='mainnet-stake-status'||purpose==='mainnet-stake-position'||purpose==='mainnet-stake-cancel'){
      if(Reflect.get(getCloudflareContext().env,'APP_NETWORK')!=='bsc-mainnet') return Response.json({error:'Mainnet signature required'},{status:400});
      actionText='Chain: BNB Smart Chain Mainnet 56';
      if(purpose==='mainnet-stake-prepare'){
        let preparation;try{preparation=normalizeMainnetStakePreparation(body.requestId,body.amountAtomic,body.referrerWallet);}catch{return Response.json({error:'Invalid stake preparation request'},{status:400});}
        purpose=preparation.purpose;
        actionText=`Action: STAKE_USDT\nAmount atomic: ${preparation.amountAtomic}\nReferral: ${preparation.referrerWallet??'none'}\nOperation: ${preparation.requestId}\nChain: BNB Smart Chain Mainnet 56`;
      }
      if(purpose==='mainnet-stake-confirm'){
        let confirmation;try{confirmation=normalizeMainnetStakeConfirmation(body.intentId,body.txHash);}catch{return Response.json({error:'Invalid stake confirmation request'},{status:400});}
        purpose=confirmation.purpose;
        actionText=`Action: CONFIRM_STAKE\nIntent: ${confirmation.intentId}\nPayment: ${confirmation.paymentHash}\nChain: BNB Smart Chain Mainnet 56`;
      }
      if(purpose==='mainnet-stake-cancel'){
        let cancellation;try{cancellation=normalizeMainnetStakeCancellation(body.requestId,body.amountAtomic);}catch{return Response.json({error:'Invalid stake cancellation request'},{status:400});}
        const env=getCloudflareContext().env as Record<string,unknown>;
        try{
          assertMainnetStakeRouteAccess(env,getAddress(wallet),'CANCEL');
          if(!publicMainnetStakingEnabled(env))assertMainnetCancellationTestAccess(env,getAddress(wallet),cancellation.amountAtomic);
        }catch{return Response.json({error:'MAINNET_STAKE_TEST_WALLET_REJECTED'},{status:403});}
        const readiness=await mainnetStakeCancellationReadiness(serverDB(),env);
        if(!readiness.ready)return Response.json({error:readiness.code},{status:503,headers:{'Cache-Control':'no-store'}});
        purpose=cancellation.purpose;
        actionText=`Action: CANCEL_STAKE\nAmount atomic: ${cancellation.amountAtomic}\nOperation: ${cancellation.requestId}\nChain: BNB Smart Chain Mainnet 56`;
      }
    }
    if(purpose==='mainnet-deposit-address'){
      try{assertMainnetFixedAddressTestAccess(getCloudflareContext().env as Record<string,unknown>,getAddress(wallet));}
      catch{return Response.json({error:'MAINNET_STAKE_TEST_GATE_REJECTED'},{status:403,headers:{'Cache-Control':'no-store'}});}
      actionText='Purpose: Assign permanent deposit address\nChain: BNB Smart Chain Mainnet 56';
    }
    if(purpose==='mainnet-swap'){
      if(Reflect.get(getCloudflareContext().env,'APP_NETWORK')!=='bsc-mainnet') return Response.json({error:'Mainnet signature required'},{status:400});
      let action;try{action=normalizeSwapAction(body.action);}catch{return Response.json({error:'Invalid mainnet swap request'},{status:400});}
      purpose=mainnetSwapPurpose(action);
      actionText=`Action: ${action.kind}\nAsset: ${action.asset}\nAmount atomic: ${action.amountAtomic}\nOperation: ${action.id}\nPayment: ${action.txHash??'not yet sent'}\nChain: BNB Smart Chain Mainnet 56`;
    }
    if(purpose==='mainnet-claim'){
      if(Reflect.get(getCloudflareContext().env,'APP_NETWORK')!=='bsc-mainnet')return Response.json({error:'Mainnet signature required'},{status:400});
      let action;try{action=normalizeMainnetClaimAction(body.action);}catch{return Response.json({error:'Invalid mainnet claim request'},{status:400});}
      try{assertMainnetPgrClaimAccess(getCloudflareContext().env as Record<string,unknown>,getAddress(wallet),action.kind,action.asset);}catch{return Response.json({error:'MAINNET_REWARD_TEST_GATE_REJECTED'},{status:403});}
      purpose=action.purpose;actionText=`Action: ${action.kind}_${action.asset}\nClaim: ${'claimId' in action?action.claimId:'reserve new claim'}\nTransaction: ${'txHash' in action?action.txHash:'not yet sent'}\nChain: BNB Smart Chain Mainnet 56`;
    }
    if(purpose==='bank-action'){
      let action;try{action=normalizeBankAction(body.action);}catch{return Response.json({error:'Invalid bank operation'},{status:400});}
      purpose=action.purpose;actionText=`Action: ${action.kind}\nAmount: ${formatUnits(BigInt(action.amountAtomic),18)} USDT\nRecipient: ${wallet}\nReferral: ${action.referrerWallet ?? 'retain confirmed referral'}\nOperation: ${action.id}\nChain: BNB Testnet 97`;
    }
    if(purpose==='mining-action'){
      let action;try{action=normalizeMiningAction(body.action);}catch{return Response.json({error:'Invalid mining request'},{status:400});}
      purpose=action.purpose;
      const env=getCloudflareContext().env as Record<string,unknown>;
      const mainnet=Reflect.get(env,'APP_NETWORK')==='bsc-mainnet';
      const configuredRecipient=Reflect.get(env,'MAINNET_MINING_PAYMENT_RECIPIENT');
      if(!mainnet||typeof configuredRecipient!=='string'||!isAddress(configuredRecipient)||/^0x0{40}$/i.test(configuredRecipient))return Response.json({error:'Mainnet mining recipient is not configured'},{status:503});
      actionText=`Action: ${action.kind}\nAmount: ${formatUnits(BigInt(action.amountAtomic),18)} PGR\nOperation: ${action.id}\nReferral: ${action.referrerWallet??'retain confirmed referral'}\nPayment: ${action.txHash??'not yet sent'}\nConsumption recipient: ${getAddress(configuredRecipient)}\nChain: BNB Smart Chain Mainnet 56`;
    }
    const nonce = crypto.randomUUID();
    const issuedAt = Date.now();
    const expiresAt = issuedAt + 5 * 60 * 1000;
    const message = ['PBMReserves wallet authorization', `Wallet: ${wallet}`, `Purpose: ${purpose}`, ...(actionText?[actionText]:[]), `Nonce: ${nonce}`, `Issued At: ${new Date(issuedAt).toISOString()}`, `Expires At: ${new Date(expiresAt).toISOString()}`].join('\n');
    await serverDB().prepare('INSERT INTO wallet_auth_challenges(nonce,wallet_address,purpose,message,expires_at) VALUES (?,?,?,?,?)')
      .bind(nonce, wallet, purpose, message, expiresAt).first();
    return Response.json({ nonce, message, expiresAt }, { headers: { 'Cache-Control': 'no-store' } });
  } catch { return Response.json({ error: 'Unable to create wallet challenge' }, { status: 503 }); }
}
