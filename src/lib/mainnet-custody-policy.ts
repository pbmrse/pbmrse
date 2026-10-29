import { getAddress, isAddress, type Address } from 'viem';

export const BSC_MAINNET_USDT = getAddress('0x55d398326f99059ff775485246999027b3197955');

export type CustodyAssetKind = 'STAKE_USDT'|'PLATFORM_GAS'|'MISTAKEN_BNB'|'MISTAKEN_SUPPORTED_TOKEN'|'UNSUPPORTED_TOKEN';

export type CustodyReceiptClassification = {
  kind: CustodyAssetKind;
  destination: Address | null;
  creditsStake: boolean;
  createsPgr: boolean;
  automaticCollection: boolean;
};

type ReceiptInput = {
  native: boolean;
  tokenAddress?: string | null;
  sourceWallet: string;
  gasWalletAddress: string;
  collectionAddress: string;
  matchedStakeIntent: boolean;
  supportedTokenAddresses: readonly string[];
};

export function classifyCustodyReceipt(input: ReceiptInput): CustodyReceiptClassification {
  if (!isAddress(input.sourceWallet) || !isAddress(input.gasWalletAddress) || !isAddress(input.collectionAddress)) {
    throw new Error('CUSTODY_RECEIPT_ADDRESS_INVALID');
  }
  const source = getAddress(input.sourceWallet);
  const gasWallet = getAddress(input.gasWalletAddress);
  if (input.native) {
    if (input.tokenAddress) throw new Error('CUSTODY_NATIVE_TOKEN_CONFLICT');
    if (source.toLowerCase() === gasWallet.toLowerCase()) {
      return {kind:'PLATFORM_GAS',destination:null,creditsStake:false,createsPgr:false,automaticCollection:false};
    }
    return {kind:'MISTAKEN_BNB',destination:getAddress(input.collectionAddress),creditsStake:false,createsPgr:false,automaticCollection:true};
  }
  if (!input.tokenAddress || !isAddress(input.tokenAddress)) throw new Error('CUSTODY_TOKEN_ADDRESS_INVALID');
  const token = getAddress(input.tokenAddress);
  if (token.toLowerCase() === BSC_MAINNET_USDT.toLowerCase() && input.matchedStakeIntent) {
    return {kind:'STAKE_USDT',destination:getAddress(input.collectionAddress),creditsStake:true,createsPgr:true,automaticCollection:true};
  }
  const supported = input.supportedTokenAddresses.some(address => isAddress(address) && getAddress(address).toLowerCase() === token.toLowerCase());
  if (supported || token.toLowerCase() === BSC_MAINNET_USDT.toLowerCase()) {
    return {kind:'MISTAKEN_SUPPORTED_TOKEN',destination:getAddress(input.collectionAddress),creditsStake:false,createsPgr:false,automaticCollection:true};
  }
  return {kind:'UNSUPPORTED_TOKEN',destination:null,creditsStake:false,createsPgr:false,automaticCollection:false};
}

export type CustodyGasAccount = {
  platformTopupAtomic: bigint;
  gasSpentAtomic: bigint;
  platformReturnedAtomic: bigint;
  userBnbDepositedAtomic: bigint;
  userBnbCollectedAtomic: bigint;
  chainBalanceAtomic: bigint;
};

/** Reconciles fungible BNB without ever charging chain gas to user-mistaken BNB. */
export function reconcileCustodyGas(account: CustodyGasAccount) {
  for (const value of Object.values(account)) if (value < 0n) throw new Error('CUSTODY_GAS_NEGATIVE');
  if (account.gasSpentAtomic + account.platformReturnedAtomic > account.platformTopupAtomic) {
    throw new Error('CUSTODY_PLATFORM_GAS_OVERRUN');
  }
  if (account.userBnbCollectedAtomic > account.userBnbDepositedAtomic) {
    throw new Error('CUSTODY_USER_BNB_OVER_COLLECTION');
  }
  const platformRemaining = account.platformTopupAtomic - account.gasSpentAtomic - account.platformReturnedAtomic;
  const userRemaining = account.userBnbDepositedAtomic - account.userBnbCollectedAtomic;
  if (platformRemaining + userRemaining !== account.chainBalanceAtomic) {
    throw new Error('CUSTODY_GAS_BALANCE_MISMATCH');
  }
  return {platformRemainingAtomic:platformRemaining,userRemainingAtomic:userRemaining};
}

export function minimumPlatformGasTopup(input:{gasPriceAtomic:bigint;collectionGasLimit:bigint;returnGasLimit:bigint;
  platformTopupAtomic:bigint;gasSpentAtomic:bigint;platformReturnedAtomic:bigint;maximumTopupAtomic:bigint}){
  for(const value of Object.values(input))if(value<0n)throw new Error('CUSTODY_GAS_NEGATIVE');
  if(input.gasPriceAtomic===0n||input.collectionGasLimit===0n||input.returnGasLimit===0n||input.maximumTopupAtomic===0n)throw new Error('CUSTODY_GAS_POLICY_DISABLED');
  if(input.gasSpentAtomic+input.platformReturnedAtomic>input.platformTopupAtomic)throw new Error('CUSTODY_PLATFORM_GAS_OVERRUN');
  const available=input.platformTopupAtomic-input.gasSpentAtomic-input.platformReturnedAtomic;
  const required=input.gasPriceAtomic*(input.collectionGasLimit+input.returnGasLimit);
  const topup=required>available?required-available:0n;
  if(topup>input.maximumTopupAtomic)throw new Error('CUSTODY_GAS_TOPUP_LIMIT_EXCEEDED');
  return {requiredAtomic:required,availableAtomic:available,topupAtomic:topup};
}

/** Final signer-side reserve check for the dedicated Gas wallet. */
export function assertCustodyGasWalletReserve(input:{
  balanceAtomic:bigint; transferAtomic:bigint; transactionGasAtomic:bigint; minimumBalanceAtomic:bigint;
}){
  for(const value of Object.values(input))if(value<0n)throw new Error('CUSTODY_GAS_NEGATIVE');
  if(input.minimumBalanceAtomic===0n)throw new Error('CUSTODY_GAS_MINIMUM_DISABLED');
  if(input.balanceAtomic<input.transferAtomic+input.transactionGasAtomic+input.minimumBalanceAtomic){
    throw new Error('CUSTODY_GAS_MINIMUM_BALANCE_VIOLATION');
  }
}

export function assertManualRefund(input: {
  originalSender:string; destination:string; amountAtomic:string; status:string; txHash?:string|null;
}) {
  if (!isAddress(input.originalSender) || !isAddress(input.destination) ||
      getAddress(input.originalSender).toLowerCase() !== getAddress(input.destination).toLowerCase()) {
    throw new Error('CUSTODY_MANUAL_REFUND_DESTINATION_MISMATCH');
  }
  if (!/^[1-9][0-9]{0,77}$/.test(input.amountAtomic)) throw new Error('CUSTODY_MANUAL_REFUND_AMOUNT_INVALID');
  if (input.status === 'PAID' && (!input.txHash || !/^0x[0-9a-fA-F]{64}$/.test(input.txHash))) {
    throw new Error('CUSTODY_MANUAL_REFUND_TX_REQUIRED');
  }
}
