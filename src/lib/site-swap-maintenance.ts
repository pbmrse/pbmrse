/** Legacy chain-97 swap retry job is retired from the mainnet Worker. */
export async function pumpSiteSwaps(_limit = 3) {
  return { swapsProcessed: 0, swapsConfirmed: 0, swapsPending: 0, swapsFailed: 0 };
}
