'use client';

import { localizedPair } from '@/lib/ui-localization';
import {useState} from 'react';
import {useAccount,useChainId,useReadContract} from 'wagmi';
import {formatUnits,parseUnits} from 'viem';
import {useBusinessAccount} from '@/components/useBusinessAccount';
import {useSiteSwap} from '@/components/useSiteSwap';
import {swapQuote} from '@/lib/swap-action';
import {MAINNET_CONTRACTS,ERC20_ABI} from '@/lib/contracts-mainnet-client';
import Navbar from '@/components/Navbar';
import { useLanguage } from '@/components/LanguageProvider';
import { BUSINESS } from '@/config/business';


export default function SwapPage() {
  const { t, language } = useLanguage();const zh=language.startsWith('zh');
  const business=useBusinessAccount({autoAuthorize:true}),swap=useSiteSwap(business.snapshot,business.accept);
  const [asset, setAsset] = useState<'PGR' | 'SOV'>('PGR');
  const [amount,setAmount]=useState('');
  const {address}=useAccount();const chainId=useChainId();
  const balanceQuery=useReadContract({chainId:56,address:MAINNET_CONTRACTS[asset==='PGR'?'pgr':'sov'],abi:ERC20_ABI,functionName:'balanceOf',args:address?[address]:undefined,query:{enabled:!!address&&chainId===56,refetchInterval:15000}});
  const balance=balanceQuery.data!==undefined?formatUnits(balanceQuery.data,18):'—';
  const price=asset==='PGR'?BUSINESS.pgrReferencePriceUSDT:BUSINESS.sovReferencePriceUSDT;
  let quote:ReturnType<typeof swapQuote>|null=null;try{if(/^\d{1,30}(\.\d{1,18})?$/.test(amount.trim()))quote=swapQuote(asset,parseUnits(amount.trim(),18));}catch{}
  const payoutStatus=(row:NonNullable<typeof business.snapshot>['swaps'][number])=>row.payout_status==='CONFIRMED'?(localizedPair(language, '兑换已完成', 'Exchange completed')):(localizedPair(language, '等待代币确认', 'Waiting for token confirmation'));
  return <main className="min-h-screen pbm-shell"><Navbar /><div className="lg:ml-[248px]"><div className="mx-auto max-w-4xl px-4 py-7 sm:px-6 sm:py-10">
    <a href="/" className="text-sm text-slate-500 hover:text-cyan-300">← {t.backHome}</a>
    <section className="pbm-panel pbm-glow pbm-page-enter relative mt-5 overflow-hidden p-5 sm:p-8">
      <div className="relative"><div className="text-xs uppercase tracking-[.2em] text-cyan-300">PBM / {t.swapEyebrow}</div></div>
      {business.busy&&<p className="mt-4 text-sm text-slate-400">{localizedPair(language, '正在加载账户…', 'Loading account…')}</p>}{business.needsAuthorization&&!business.busy&&<button className="pbm-btn pbm-btn-secondary mt-4" onClick={business.load}>{localizedPair(language, '重新连接账户', 'Reconnect account')}</button>}{business.error&&<p className="mt-3 text-sm text-rose-300">{business.error}</p>}
      <div className="mt-6 grid grid-cols-2 gap-2">{(['PGR','SOV'] as const).map(x => <button key={x} type="button" onClick={()=>setAsset(x)} className={`rounded-xl border px-4 py-3 text-sm font-bold ${asset===x ? 'border-cyan-300/60 bg-cyan-400/10 text-cyan-200' : 'border-blue-900/60 bg-blue-950/20 text-slate-400'}`}>{x} → USDT</button>)}</div>
      <div className="mt-4 grid gap-4"><div className="pbm-panel bg-[#020a1b]/60 p-5"><div className="text-xs text-slate-500">{asset} {t.availableBalance}</div><div className="mt-2 min-w-0 break-all text-2xl font-black sm:text-3xl">{balance} <span className="break-normal text-sm text-cyan-300">{asset}</span></div></div></div>
      <div className="mt-5 rounded-2xl border border-blue-900/60 bg-[#020817]/70 p-5">
        <label className="text-sm text-slate-300">{asset} {t.amount}</label>
        <div className="mt-2 flex gap-2"><input className="input flex-1 text-lg" inputMode="decimal" placeholder={t.enterAmount} value={amount} onChange={e => setAmount(e.target.value)} /><div className="flex items-center rounded-xl border border-blue-900/60 bg-blue-950/40 px-4 text-sm font-bold">{asset}</div></div>
        <div className="mt-3 space-y-2 text-sm text-slate-400"><div>{localizedPair(language, '兑换价格', 'Exchange price')}: <span className="text-cyan-200">1 {asset} = {price} USDT</span></div><div>{localizedPair(language, '兑换金额', 'Gross value')}: {quote?formatUnits(quote.gross,18):'—'} USDT</div></div>
        

        <button className="pbm-btn pbm-btn-primary mt-5 w-full disabled:cursor-not-allowed disabled:opacity-50" disabled={swap.busy||!business.snapshot?.swapEnabled||!quote} onClick={()=>void swap.execute(asset,amount)}>{swap.busy?(localizedPair(language, '正在处理…', 'Processing…')):(localizedPair(language, '确认兑换', 'Confirm exchange'))}</button>
        
        {swap.status&&<p role="status" className="mt-3 text-sm text-cyan-300">{swap.status}</p>}{swap.error&&<p role="alert" className="mt-3 break-words text-sm text-rose-300">{swap.error}</p>}
      </div>
    </section>
    <section className="pbm-panel mt-5 p-5 sm:p-7"><div className="text-xs uppercase tracking-[.2em] text-cyan-300">PBM / {t.swapHistoryEyebrow}</div><div className="mt-4 overflow-x-auto rounded-xl border border-blue-900/60 bg-[#020817]/60"><table className="w-full text-left text-xs"><thead><tr>{([localizedPair(language,'转出数量','Tokens sent'),localizedPair(language,'兑换金额 USDT','Gross USDT'),localizedPair(language,'手续费 USDT','Fee USDT'),localizedPair(language,'应付 USDT','USDT due'),localizedPair(language,'兑换状态','Payout status'),localizedPair(language,'时间','Time'),localizedPair(language,'交易哈希','Transaction Hash')]).map(h=><th className="whitespace-nowrap p-3 text-slate-500" key={h}>{h}</th>)}</tr></thead><tbody>{business.snapshot?.swaps.map(row=><tr key={row.intent_id} className="border-t border-blue-950/70"><td className="whitespace-nowrap p-3">{formatUnits(BigInt(row.amount_atomic),18)} {row.asset}</td>{[row.gross_usdt_atomic,row.fee_usdt_atomic,row.net_usdt_atomic].map((n,i)=><td key={i} className="p-3">{formatUnits(BigInt(n),18)}</td>)}<td className="whitespace-nowrap p-3">{payoutStatus(row)}</td><td className="whitespace-nowrap p-3">{new Date(row.created_at).toLocaleString(language)}</td><td className="p-3">{row.payout_tx_hash?<a className="text-cyan-300" href={`https://bscscan.com/tx/${row.payout_tx_hash}`} target="_blank" rel="noreferrer">{row.payout_tx_hash.slice(0,8)}…{row.payout_tx_hash.slice(-6)} ↗</a>:'—'}</td></tr>)}</tbody></table>{!business.snapshot?.swaps.length&&<p className="p-5 text-sm text-slate-500">{t.noRecords}</p>}</div></section>

  </div></div></main>;
}
