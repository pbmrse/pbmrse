import { getCloudflareContext } from '@opennextjs/cloudflare';
import { createPublicClient, http, type Hex } from 'viem';
import { bsc } from 'viem/chains';
import { mainnetContracts } from './contracts-mainnet';
import {authenticatedSignerRequest,validSignerCallerSecret} from './signer-service-auth';

type RewardSignerBinding={fetch(request:Request):Promise<Response>};

function envString(name: string): string | undefined {
  const value = Reflect.get(getCloudflareContext().env, name);
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * Read-only mainnet reward-claim configuration. This does not issue or sign a
 * claim and is deliberately not imported by the current chain-97 claim engine.
 */
export function mainnetRewardClaimsEnabled(): boolean {
  if (envString('APP_NETWORK') !== 'bsc-mainnet' ||
      envString('MAINNET_FINANCIAL_MODE') !== 'enabled' ||
      envString('MAINNET_REWARD_CLAIMS_ENABLED') !== 'true') return false;
  try {
    const contracts = mainnetContracts();
    const expectedSigner = envString('MAINNET_MINT_SIGNER_ADDRESS');
    const callerSecret=envString('REWARD_SIGNER_CALLER_SECRET');
    const signer=Reflect.get(getCloudflareContext().env,'REWARD_SIGNER') as RewardSignerBinding|undefined;
    if (!contracts.pgr || !contracts.sov || !envString('BSC_MAINNET_RPC_URL') || !signer || typeof signer.fetch!=='function' ||
        !validSignerCallerSecret(callerSecret) ||
        !expectedSigner || !/^0x[0-9a-fA-F]{40}$/.test(expectedSigner) ||
        /^0x0{40}$/i.test(expectedSigner)) return false;
    return true;
  } catch {
    return false;
  }
}

export function mainnetReceiptClient() {
  if (envString('APP_NETWORK') !== 'bsc-mainnet') throw new Error('Mainnet network is not configured');
  const rpc = envString('BSC_MAINNET_RPC_URL');
  if (!rpc) throw new Error('Mainnet RPC is not configured');
  const client = createPublicClient({chain:bsc,transport:http(rpc,{timeout:15000,retryCount:1})});
  return {client,assertChain:async()=>{if(await client.getChainId()!==56)throw new Error('Mainnet RPC network mismatch');}};
}

export function mainnetRewardClaimClients() {
  if (!mainnetRewardClaimsEnabled()) {
    throw new Error('Mainnet reward claims are disabled or not fully configured');
  }
  const rpc = envString('BSC_MAINNET_RPC_URL');
  const callerSecret=envString('REWARD_SIGNER_CALLER_SECRET');
  const signer=Reflect.get(getCloudflareContext().env,'REWARD_SIGNER') as RewardSignerBinding|undefined;
  if (!rpc || !validSignerCallerSecret(callerSecret) || !signer || typeof signer.fetch!=='function') throw new Error('Mainnet reward signer binding, caller authentication and RPC are required');
  const client = createPublicClient({ chain: bsc, transport: http(rpc, { timeout: 15000, retryCount: 1 }) });
  return {
    client,
    authorize:async(claimId:Hex)=>{
      const body=JSON.stringify({claimId});
      const request=await authenticatedSignerRequest('https://reward-signer.internal/v1/sign',body,callerSecret,'pbmrse-reward-signer:v1');
      const response=await signer.fetch(request);
      if(!response.ok)throw new Error(`REWARD_SIGNER_REJECTED_${response.status}`);
      return response.json() as Promise<{chainId:56;token:`0x${string}`;recipient:`0x${string}`;amount:string;claimId:Hex;deadline:string;epoch:string;signature:Hex}>;
    },
    assertChain: async () => {
      if (await client.getChainId() !== 56) throw new Error('Mainnet reward RPC network mismatch');
    },
  };
}
