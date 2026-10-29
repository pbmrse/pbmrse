/** Legacy chain-97 mining purchase retry job is retired from the mainnet Worker. */
export async function pumpMiningPurchases(_limit = 3) {
  return { miningPurchasesProcessed: 0, miningPurchasesConfirmed: 0, miningPurchasesPending: 0, miningPurchasesFailed: 0 };
}
