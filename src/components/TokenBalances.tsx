'use client';
import { localizedPair } from '@/lib/ui-localization';
import { useAccount, useChainId, useReadContract } from 'wagmi';
import { formatUnits } from 'viem';
import { useLanguage } from './LanguageProvider';
import { ERC20_ABI, MAINNET_CONTRACTS } from '@/lib/contracts-mainnet-client';
function Balance({ asset }: { asset: keyof typeof MAINNET_CONTRACTS }) {
  const { address } = useAccount(); const chainId = useChainId();
  const { language } = useLanguage(); const zh = language.startsWith('zh');
  const result = useReadContract({ address: MAINNET_CONTRACTS[asset], abi: ERC20_ABI, functionName: 'balanceOf', args: address ? [address] : undefined, chainId: 56, query: { enabled: !!address && chainId === 56, refetchInterval: 15000 } });
  return <div className="rounded-xl border border-blue-900/50 p-4"><div className="text-xs text-slate-400">{asset.toUpperCase()}</div><div className="mt-2 break-all text-2xl font-bold">{address && chainId === 56 && result.data !== undefined ? formatUnits(result.data, 18) : '—'}</div>{result.isError && <p className="mt-2 text-xs text-rose-300">{localizedPair(language, '余额读取失败', 'Unable to read balance')}</p>}</div>;
}
export function WalletBalanceCards() {
  const { language } = useLanguage(); const zh = language.startsWith('zh');
  return <div className="grid gap-3 sm:grid-cols-3">{(['usdt', 'pgr', 'sov'] as const).map(asset => <Balance key={asset} asset={asset} />)}</div>;
}
