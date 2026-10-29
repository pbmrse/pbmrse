import { getCloudflareContext } from '@opennextjs/cloudflare';
import { createPublicClient, getAddress, http, type Address, type Hash } from 'viem';
import { bsc } from 'viem/chains';
import { MAINNET_CHAIN_ID } from './contracts-mainnet';
import { authenticatedSignerRequest, validSignerCallerSecret } from './signer-service-auth';

type TreasurySignerBinding = {
  fetch(request: Request): Promise<Response>;
};

export type TreasurySignedJob = {
  jobId: string;
  txHash: Hash;
  nonce: number;
  status: 'SIGNED';
};

function envString(name: string): string | undefined {
  const value = Reflect.get(getCloudflareContext().env, name);
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * Public Worker gate for Treasury execution. The Treasury private key is
 * intentionally not read here; signing is delegated to the private signer
 * Worker, which revalidates the immutable D1 obligation before signing.
 */
export function mainnetBankEnabled(): boolean {
  if (envString('APP_NETWORK') !== 'bsc-mainnet' ||
      envString('MAINNET_FINANCIAL_MODE') !== 'enabled' ||
      envString('MAINNET_BANK_ENABLED') !== 'true') return false;
  const rpc = envString('BSC_MAINNET_RPC_URL');
  const expectedTreasury = envString('MAINNET_TREASURY_ADDRESS');
  const callerSecret = envString('TREASURY_SIGNER_CALLER_SECRET');
  const signer = Reflect.get(getCloudflareContext().env, 'TREASURY_SIGNER') as TreasurySignerBinding | undefined;
  return !!rpc && !!expectedTreasury && /^0x[0-9a-fA-F]{40}$/.test(expectedTreasury) &&
    !/^0x0{40}$/i.test(expectedTreasury) && validSignerCallerSecret(callerSecret) &&
    !!signer && typeof signer.fetch === 'function';
}

export function mainnetBankClients() {
  if (!mainnetBankEnabled()) throw new Error('Mainnet bank operations are disabled');
  const rpc = envString('BSC_MAINNET_RPC_URL');
  const expectedTreasury = envString('MAINNET_TREASURY_ADDRESS');
  const callerSecret = envString('TREASURY_SIGNER_CALLER_SECRET');
  const signer = Reflect.get(getCloudflareContext().env, 'TREASURY_SIGNER') as TreasurySignerBinding | undefined;
  if (!rpc || !expectedTreasury || !validSignerCallerSecret(callerSecret) || !signer || typeof signer.fetch !== 'function') {
    throw new Error('Mainnet Treasury signer binding or caller authentication is unavailable');
  }
  const address = getAddress(expectedTreasury);
  const transport = http(rpc, { timeout: 15000, retryCount: 1 });
  const client = createPublicClient({ chain: bsc, transport });
  return {
    address,
    client,
    signTreasuryJob: async (jobId: string, leaseToken: string, fencingToken: number): Promise<TreasurySignedJob> => {
      const body = JSON.stringify({ jobId, leaseToken, fencingToken });
      const request = await authenticatedSignerRequest(
        'https://treasury-signer.internal/v1/sign', body, callerSecret, 'pbmrse-treasury-signer:v1',
      );
      const response = await signer.fetch(request);
      if (!response.ok) throw new Error(`TREASURY_SIGNER_REJECTED_${response.status}`);
      const result = await response.json() as Partial<TreasurySignedJob>;
      if (result.jobId !== jobId || result.status !== 'SIGNED' ||
          !Number.isSafeInteger(result.nonce) || (result.nonce ?? -1) < 0 ||
          typeof result.txHash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(result.txHash)) {
        throw new Error('TREASURY_SIGNER_RESPONSE_INVALID');
      }
      return result as TreasurySignedJob;
    },
    assertChain: async () => {
      if (await client.getChainId() !== MAINNET_CHAIN_ID) {
        throw new Error('Mainnet bank RPC network mismatch');
      }
    },
  };
}

export function mainnetBankWalletEnabled(_wallet: Address): boolean {
  // Do not use the testnet diagnostic-wallet allowlist on mainnet.
  // Wallet-specific policy should be added only if the mainnet business rules require it.
  return mainnetBankEnabled();
}
