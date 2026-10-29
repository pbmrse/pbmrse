'use client';
import { useRef, useState } from 'react';
import { useAccount, useChainId, usePublicClient, useSignMessage, useWriteContract } from 'wagmi';
import { formatUnits, getAddress, parseUnits, type Hash } from 'viem';
// Public BSC mainnet USDT address; keep server-only Cloudflare config out of the client bundle.
const MAINNET_USDT = getAddress('0x55d398326f99059fF775485246999027B3197955');
import { ERC20_ABI } from '@/lib/contracts-mainnet-client';

type StakeIntent = { intentId: string; custodyAddress: `0x${string}`; amountAtomic: string };
type Saved = { requestId: string; amountAtomic: string; referrerWallet:string|null; intentId?: string; custodyAddress?: `0x${string}`; txHash?: Hash };
type SavedCancellation = { requestId: string; amountAtomic: string };
const POST = async (path: string, body: unknown) => {
  const response = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await response.json() as Record<string, unknown>;
  if (!response.ok) throw new Error(String(data.error ?? 'Mainnet staking unavailable'));
  return data;
};

/** Chain-56 entry point. Never sends USDT unless the server accepts PREPARE. */
export function useMainnetStake() {
  const { address } = useAccount();
  const chainId = useChainId();
  const client = usePublicClient({ chainId: 56 });
  const { signMessageAsync } = useSignMessage();
  const { writeContractAsync } = useWriteContract();
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const locked = useRef(false);

  async function authorized(action: 'PREPARE' | 'CONFIRM' | 'STATUS' | 'POSITION' | 'CANCEL', fields: Record<string, unknown>) {
    if (!address) throw new Error('Connect your wallet');
    const challenge = await POST('/api/user/challenge', { walletAddress: address, purpose: 'mainnet-stake-' + action.toLowerCase(), ...fields });
    const signature = await signMessageAsync({ account: address, message: String(challenge.message) });
    return POST('/api/user/mainnet-stake', { walletAddress: address, chainId: 56, action, nonce: challenge.nonce, signature, ...fields });
  }

  async function stake(amount: string, referrerWallet: string | null = null) {
    if (!address || chainId !== 56 || !client || locked.current) return;
    locked.current = true; setBusy(true); setError(''); setStatus('');
    const key = 'pbm-mainnet-stake:56:' + address.toLowerCase();
    try {
      const amountAtomic = parseUnits(amount, 18).toString();
      if (BigInt(amountAtomic) <= 0n) throw new Error('Invalid stake amount');
      let saved: Saved | null = JSON.parse(localStorage.getItem(key) || 'null');
      if (saved && saved.amountAtomic !== amountAtomic) throw new Error('Complete the previous stake before changing amount');
      if (!saved) saved = { requestId: crypto.randomUUID(), amountAtomic, referrerWallet };
      if (saved.referrerWallet === undefined) saved.referrerWallet = referrerWallet;
      if (saved.referrerWallet !== referrerWallet) throw new Error('Complete the previous stake before changing referrer');
      // PREPARE is server-gated. When disabled, no wallet transfer is attempted.
      if (!saved.txHash) {
        setStatus('Preparing mainnet stake');
        const intent = await authorized('PREPARE', { requestId: saved.requestId, amountAtomic, referrerWallet:saved.referrerWallet }) as unknown as StakeIntent;
        if (intent.amountAtomic !== amountAtomic || !/^0x[0-9a-fA-F]{40}$/.test(intent.custodyAddress)) throw new Error('Stake intent mismatch');
        saved.intentId = intent.intentId; saved.custodyAddress = intent.custodyAddress;
        localStorage.setItem(key, JSON.stringify(saved));
        setStatus('Confirm USDT transfer in your wallet');
        const hash = await writeContractAsync({ account: address, chainId: 56, address: MAINNET_USDT, abi: ERC20_ABI, functionName: 'transfer', args: [intent.custodyAddress, BigInt(amountAtomic)] });
        saved.txHash = hash;
        localStorage.setItem(key, JSON.stringify(saved));
      }
      if (!saved.intentId || !saved.txHash) throw new Error('Missing original stake payment');
      setStatus('Waiting for 12 mainnet confirmations');
      const receipt = await client.waitForTransactionReceipt({ hash: saved.txHash, confirmations: 12, timeout: 180000 });
      if (receipt.status !== 'success') throw new Error('USDT transfer failed; verify the transaction before retrying');
      setStatus('Confirming verified mainnet payment');
      const result = await authorized('CONFIRM', { intentId: saved.intentId, txHash: saved.txHash });
      if (result.status !== 'CONFIRMED') throw new Error('Stake payment not yet confirmed');
      localStorage.removeItem(key);
      setStatus('Payment confirmed on chain; stake accounting is pending activation');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Mainnet staking unavailable');
    } finally { locked.current = false; setBusy(false); }
  }
  async function cancel(amount: string) {
    if (!address || chainId !== 56 || locked.current) return;
    locked.current = true; setBusy(true); setError(''); setStatus('');
    const key = 'pbm-mainnet-stake-cancel:56:' + address.toLowerCase();
    try {
      const amountAtomic = parseUnits(amount, 18).toString();
      if (BigInt(amountAtomic) <= 0n) throw new Error('Mainnet staking unavailable');
      let saved: SavedCancellation | null = JSON.parse(localStorage.getItem(key) || 'null');
      if (saved && saved.amountAtomic !== amountAtomic) throw new Error('Mainnet staking unavailable');
      if (!saved) saved = { requestId: crypto.randomUUID(), amountAtomic };
      localStorage.setItem(key, JSON.stringify(saved));
      const result = await authorized('CANCEL', saved);
      if (result.amountAtomic !== amountAtomic || !['READY','PREPARING','SIGNED','SENT','CONFIRMED'].includes(String(result.status)) ||
          BigInt(String(result.feeAtomic)) + BigInt(String(result.refundAtomic)) !== BigInt(amountAtomic)) {
        throw new Error('Mainnet staking unavailable');
      }
      localStorage.removeItem(key);
      setStatus(String(result.status));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Mainnet staking unavailable');
    } finally { locked.current = false; setBusy(false); }
  }
  async function maximum() {
    if (!address || chainId !== 56 || locked.current) return '';
    locked.current = true; setBusy(true); setError('');
    try {
      const result = await authorized('POSITION', {});
      if (result.walletAddress?.toString().toLowerCase() !== address.toLowerCase() || result.chainId !== 56 ||
          typeof result.principalAtomic !== 'string' || !/^(0|[1-9][0-9]*)$/.test(result.principalAtomic)) {
        throw new Error('Mainnet staking unavailable');
      }
      return formatUnits(BigInt(result.principalAtomic), 18);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Mainnet staking unavailable');
      return '';
    } finally { locked.current = false; setBusy(false); }
  }
  return { stake, cancel, maximum, busy, status, error };
}
