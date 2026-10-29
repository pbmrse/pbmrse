import { mainnetBankEnabled, mainnetBankClients } from './mainnet-bank-config';
import { processMainnetBankJob } from './mainnet-bank-payouts';
import { processMainnetStakeRefund } from './mainnet-stake-refund-executor';
import { serverDB } from './server-db';

/**
 * The only automatic Treasury queue pump. Refunds and Swap payouts are ordered
 * together so a single invocation owns nonce progress for the shared EOA.
 */
export async function pumpMainnetTreasuryQueue(limit = 8) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 20) throw new Error('Invalid Treasury batch limit');
  if (!mainnetBankEnabled()) return { processed:0 };
  const { address } = mainnetBankClients();
  const jobs = await serverDB().prepare(`SELECT job_id,operation_id FROM bank_transaction_queue
    WHERE chain_id=56 AND lower(sender_address)=lower(?)
      AND ((job_id='stake-refund:'||operation_id AND operation_id LIKE 'stake-cancel:%')
        OR (job_id='swap-payout:'||operation_id AND operation_id LIKE 'swap:%'))
      AND status IN ('PENDING','PREPARING','SIGNED','SENT','CONFIRMED')
    ORDER BY CASE status WHEN 'SENT' THEN 0 WHEN 'SIGNED' THEN 1 WHEN 'PREPARING' THEN 2 WHEN 'PENDING' THEN 3 ELSE 4 END,
      created_at,job_id LIMIT ?`).bind(address, limit).all<{job_id:string;operation_id:string}>();
  let processed = 0;
  for (const job of jobs.results) {
    try {
      const result = job.operation_id.startsWith('stake-cancel:')
        ? await processMainnetStakeRefund(job.operation_id)
        : await processMainnetBankJob(job.job_id);
      if (result.processed) processed++;
    } catch (error) {
      console.error(JSON.stringify({
        event:'mainnet_treasury_queue_retry', jobId:job.job_id,
        error:error instanceof Error ? error.name : 'UnknownError',
      }));
    }
  }
  return { processed };
}
