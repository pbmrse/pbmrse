export const MIN_DEPOSIT_CONFIRMATIONS = BigInt(12);
export function sumMatchingTransfers(transfers: { token: string; to: string; value: bigint }[], token: string, recipient: string): bigint {
  return transfers.reduce((total, transfer) => transfer.token.toLowerCase() === token.toLowerCase() && transfer.to.toLowerCase() === recipient.toLowerCase() ? total + transfer.value : total, BigInt(0));
}
export function sufficientlyConfirmed(latest: bigint, deposited: bigint): boolean {
  return latest >= deposited && latest - deposited + BigInt(1) >= MIN_DEPOSIT_CONFIRMATIONS;
}
export function depositSQL(chainId:56|97){
  if(chainId!==56&&chainId!==97)throw new Error('Unsupported deposit network');
  const network=chainId===97?'BSC_TESTNET':'BSC';
  return {
    insertDeposit:`INSERT INTO deposits (wallet_address,deposit_address,network,asset,amount,tx_hash,block_number,status,created_at,confirmed_at) VALUES (?,?,'${network}','USDT',?,?,?,'CONFIRMED',?,?) ON CONFLICT(tx_hash) DO NOTHING`,
    insertCredit:`INSERT INTO wallet_ledger (wallet_address,chain_id,asset,amount_atomic,entry_type,source_key,created_at) SELECT wallet_address,${chainId},'USDT',?,'DEPOSIT',?,? FROM deposits WHERE tx_hash=? AND wallet_address=? AND network='${network}' AND status='CONFIRMED' ON CONFLICT(source_key) DO NOTHING`,
  };
}
export const INSERT_DEPOSIT=depositSQL(56).insertDeposit;
export const INSERT_DEPOSIT_CREDIT=depositSQL(56).insertCredit;
