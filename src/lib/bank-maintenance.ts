/** Legacy chain-97 queue and deposit jobs are not run by the mainnet Worker. */
export async function pumpBankQueue(_limit = 5): Promise<never> {
  throw new Error('MAINNET_BANK_QUEUE_NOT_READY');
}
export async function scanBankDeposits(): Promise<never> {
  throw new Error('MAINNET_DEPOSIT_SCAN_NOT_READY');
}
export async function queueBankCollections(): Promise<never> {
  throw new Error('MAINNET_BANK_COLLECTIONS_NOT_READY');
}
export async function bankMaintenance(): Promise<never> {
  throw new Error('MAINNET_LEGACY_MAINTENANCE_DISABLED');
}
