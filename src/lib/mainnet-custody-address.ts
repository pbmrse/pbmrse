import { getCloudflareContext } from '@opennextjs/cloudflare';
import { createPublicClient, getAddress, http, isAddress, type Address } from 'viem';
import { authenticatedSignerRequest, validSignerCallerSecret } from './signer-service-auth';
import { serverDB } from './server-db';
import {mainnetStakeAddressGrant} from './mainnet-stake-test-gate';
type InternalFetcher={fetch(request:Request):Promise<Response>};

/**
 * Resolve an immutable binding. New addresses are derived only by the isolated
 * Custody Signer; the public Worker stores public metadata and never sees root
 * or child private keys.
 */
export async function mainnetCustodyAddress(owner: Address): Promise<Address> {
  const wallet = owner.toLowerCase();
  const db = serverDB();
  const row = await db.prepare(`SELECT deposit_address,derivation_version,derivation_index FROM wallet_custody_addresses
    WHERE chain_id=56 AND lower(wallet_address)=lower(?)`).bind(wallet).first<{deposit_address:string;derivation_version:string;derivation_index:number}>();
  if (!row) {
    const env=getCloudflareContext().env;
    const signer=Reflect.get(env,'CUSTODY_SIGNER') as InternalFetcher|undefined;
    const secret=Reflect.get(env,'CUSTODY_SIGNER_CALLER_SECRET');
    const rpc=Reflect.get(env,'BSC_MAINNET_RPC_URL');
    if(!signer||typeof secret!=='string'||!validSignerCallerSecret(secret)||typeof rpc!=='string')throw new Error('MAINNET_CUSTODY_ADDRESS_NOT_PROVISIONED');
    const productionProvisioning=Reflect.get(env,'MAINNET_FINANCIAL_MODE')==='enabled'&&Reflect.get(env,'MAINNET_CUSTODY_COLLECTION_READY')==='true';
    const acceptance=productionProvisioning?undefined:mainnetStakeAddressGrant(env as Record<string,unknown>,getAddress(owner));
    const body=JSON.stringify({ownerWallet:getAddress(owner),...(acceptance?{acceptance}:{})});
    const request=await authenticatedSignerRequest('https://custody-signer.internal/v1/address',body,secret,'pbmrse-custody-signer:v1');
    const response=await signer.fetch(request);
    if(!response.ok)throw new Error('MAINNET_CUSTODY_ADDRESS_SIGNER_REJECTED');
    const derived=await response.json() as {matches?:unknown;ownerWallet?:unknown;address?:unknown;rootFingerprint?:unknown;derivationVersion?:unknown;derivationIndex?:unknown};
    if(derived.matches!==true||typeof derived.ownerWallet!=='string'||derived.ownerWallet.toLowerCase()!==wallet||
      typeof derived.address!=='string'||!isAddress(derived.address)||/^0x0{40}$/i.test(derived.address)||
      typeof derived.rootFingerprint!=='string'||!/^0x[0-9a-fA-F]{64}$/.test(derived.rootFingerprint)||
      derived.derivationVersion!=='PBMRESERVES_HMAC_SHA256_V1'||!Number.isSafeInteger(derived.derivationIndex)||Number(derived.derivationIndex)<0||Number(derived.derivationIndex)>9)throw new Error('MAINNET_CUSTODY_ADDRESS_SIGNER_INVALID');
    const client=createPublicClient({transport:http(rpc,{timeout:10000,retryCount:1})});
    if(await client.getChainId()!==56)throw new Error('MAINNET_CUSTODY_RPC_CHAIN_MISMATCH');
    const scanBlock=await client.getBlockNumber();
    if(scanBlock>BigInt(Number.MAX_SAFE_INTEGER))throw new Error('MAINNET_CUSTODY_BLOCK_OVERFLOW');
    const createdAt=Date.now(),depositAddress=getAddress(derived.address).toLowerCase();
    await db.batch([
      db.prepare(`INSERT INTO wallet_custody_addresses(wallet_address,chain_id,deposit_address,root_fingerprint,scan_block,created_at,derivation_version,derivation_index)
        VALUES (?,56,?,?,?,?,?,?) ON CONFLICT(wallet_address,chain_id) DO NOTHING`).bind(wallet,depositAddress,derived.rootFingerprint.toLowerCase(),Number(scanBlock),createdAt,String(derived.derivationVersion),Number(derived.derivationIndex)),
      db.prepare(`INSERT INTO custody_scan_state(custody_address,owner_wallet,chain_id,next_block,status,updated_at)
        SELECT lower(deposit_address),lower(wallet_address),56,scan_block+1,'ACTIVE',? FROM wallet_custody_addresses
        WHERE chain_id=56 AND lower(wallet_address)=lower(?) ON CONFLICT(custody_address) DO NOTHING`).bind(createdAt,wallet),
    ]);
    return mainnetCustodyAddress(owner);
  }
  if (!isAddress(row.deposit_address) || /^0x0{40}$/i.test(row.deposit_address) ||
      row.derivation_version!=='PBMRESERVES_HMAC_SHA256_V1'||!Number.isSafeInteger(row.derivation_index)||row.derivation_index<0||row.derivation_index>9) {
    throw new Error('MAINNET_CUSTODY_ADDRESS_INVALID');
  }
  await db.prepare(`INSERT INTO custody_scan_state(custody_address,owner_wallet,chain_id,next_block,status,updated_at)
    SELECT lower(deposit_address),lower(wallet_address),56,scan_block+1,'ACTIVE',? FROM wallet_custody_addresses
    WHERE chain_id=56 AND lower(wallet_address)=lower(?) ON CONFLICT(custody_address) DO NOTHING`).bind(Date.now(),wallet).run();
  const collision = await db.prepare(`SELECT COUNT(*) AS count FROM wallet_custody_addresses
    WHERE chain_id=56 AND lower(deposit_address)=lower(?)`).bind(row.deposit_address).first<{count:number}>();
  if (collision?.count !== 1) throw new Error('MAINNET_CUSTODY_ADDRESS_CONFLICT');
  return getAddress(row.deposit_address);
}
