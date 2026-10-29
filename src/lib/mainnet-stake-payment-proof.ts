import { decodeEventLog, decodeFunctionData, parseAbi, type Address, type Hash } from 'viem';
import { MAINNET_USDT } from './contracts-mainnet';
const MAINNET_STAKE_CONFIRMATIONS = 12n;
function stakeConfirmed(latest: bigint, deposited: bigint): boolean {
  return latest >= deposited && latest - deposited + 1n >= MAINNET_STAKE_CONFIRMATIONS;
}
import { mainnetReceiptClient } from './mainnet-reward-config';

const TRANSFER_ABI = parseAbi(['event Transfer(address indexed from,address indexed to,uint256 value)', 'function transfer(address to,uint256 value) returns (bool)']);

/** Read-only proof of a confirmed USDT transfer into an assigned mainnet custody address.
 * This deliberately does NOT credit a balance or create a staking position.
 * Persistence and replay protection must be implemented before accepting funds.
 */
export async function verifyMainnetStakePayment(args: {
  hash: Hash;
  wallet: Address;
  custody: Address;
  minimumAtomic: bigint;
}) {
  if (!/^0x[0-9a-fA-F]{64}$/.test(args.hash) ||
      !/^0x[0-9a-fA-F]{40}$/.test(args.wallet) ||
      !/^0x[0-9a-fA-F]{40}$/.test(args.custody) ||
      /^0x0{40}$/i.test(args.wallet) ||
      /^0x0{40}$/i.test(args.custody) ||
      args.minimumAtomic <= 0n) throw new Error('INVALID_MAINNET_STAKE_PROOF');
  const { client, assertChain } = mainnetReceiptClient();
  await assertChain();
  const receipt = await client.getTransactionReceipt({ hash: args.hash });
  if (receipt.status !== 'success' || !receipt.blockHash) throw new Error('STAKE_TX_NOT_SUCCESSFUL');
  const [tx, block, latest] = await Promise.all([
    client.getTransaction({ hash: args.hash }),
    client.getBlock({ blockNumber: receipt.blockNumber }),
    client.getBlockNumber(),
  ]);
  // Legacy-format transactions may omit chainId; the RPC chain was independently checked.
  if ((tx.chainId != null && tx.chainId !== 56) ||
      tx.hash.toLowerCase() !== args.hash.toLowerCase() ||
      tx.blockHash !== receipt.blockHash ||
      tx.blockNumber !== receipt.blockNumber ||
      block.hash !== receipt.blockHash ||
      receipt.transactionHash.toLowerCase() !== args.hash.toLowerCase() ||
      tx.from.toLowerCase() !== args.wallet.toLowerCase() ||
      tx.to?.toLowerCase() !== MAINNET_USDT.toLowerCase() ||
      tx.value !== 0n ||
      !stakeConfirmed(latest, receipt.blockNumber)) throw new Error('STAKE_TX_NOT_VERIFIED');
  // Require an ordinary direct ERC-20 transfer, not a contract call with incidental logs.
  let requestedAtomic: bigint;
  try {
    const decoded = decodeFunctionData({ abi: TRANSFER_ABI, data: tx.input });
    if (decoded.functionName !== 'transfer' ||
        decoded.args[0].toLowerCase() !== args.custody.toLowerCase() ||
        decoded.args[1] <= 0n) throw new Error('INVALID_TRANSFER_CALL');
    requestedAtomic = decoded.args[1];
  } catch { throw new Error('STAKE_USDT_TRANSFER_CALL_MISMATCH'); }
  let amountAtomic = 0n;
  let matchingTransfers = 0;
  let matchingLogIndex = -1;
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== MAINNET_USDT.toLowerCase()) continue;
    try {
      const event = decodeEventLog({ abi: TRANSFER_ABI, data: log.data, topics: log.topics });
      if (event.eventName === 'Transfer' &&
          event.args.from.toLowerCase() === args.wallet.toLowerCase() &&
          event.args.to.toLowerCase() === args.custody.toLowerCase()) {
        amountAtomic += event.args.value;
        matchingTransfers++;
        matchingLogIndex = log.logIndex;
      }
    } catch { /* unrelated token event */ }
  }
  if (matchingTransfers !== 1 || amountAtomic !== requestedAtomic || amountAtomic < args.minimumAtomic) throw new Error('STAKE_USDT_TRANSFER_MISMATCH');
  if (!Number.isSafeInteger(matchingLogIndex) || matchingLogIndex < 0) throw new Error('STAKE_USDT_LOG_INDEX_INVALID');
  return { chainId: 56 as const, hash: args.hash, wallet: args.wallet, custody: args.custody, amountAtomic, logIndex:matchingLogIndex, blockNumber: receipt.blockNumber, blockHash:receipt.blockHash, blockTimestamp: block.timestamp };
}
