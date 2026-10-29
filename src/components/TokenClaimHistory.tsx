'use client';
import {formatUnits} from 'viem';
import {localizedPair} from '@/lib/ui-localization';
import {useLanguage} from './LanguageProvider';

type ClaimHistoryItem={
  claim_id:string;
  asset:'PGR'|'SOV';
  amount_atomic:string;
  status:'RESERVED'|'MINTED';
  created_at:number;
  tx_hash:string|null;
  confirmed_at:number|null;
};

export default function TokenClaimHistory({asset,claims=[]}:{asset:'pgr'|'sov';claims?:ClaimHistoryItem[]}){
  const {language}=useLanguage();
  const token=asset.toUpperCase() as 'PGR'|'SOV';
  const confirmed=claims.filter(item=>item.asset===token&&item.status==='MINTED'&&item.tx_hash);
  return <div className="mt-6 border-t border-blue-900/60 pt-5">
    <h3 className="text-base font-bold">{localizedPair(language,'收益记录','Reward History')}</h3>
    {!confirmed.length?<p className="mt-3 text-sm text-slate-500">{localizedPair(language,'暂无收益记录','No reward records')}</p>:<div className="mt-3 space-y-3">{confirmed.map((item,index)=><div key={item.claim_id} className="rounded-xl border border-blue-900/60 bg-[#020817]/60 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2"><span className="text-xs text-slate-400">{localizedPair(language,`收益 #${confirmed.length-index}`,`Reward #${confirmed.length-index}`)}</span><span className="font-semibold text-emerald-300">{formatUnits(BigInt(item.amount_atomic),18)} {token}</span></div>
      <div className="mt-2 text-xs font-medium text-emerald-300">{localizedPair(language,'已确认','Confirmed')}</div>
      <div className="mt-2 text-xs text-slate-400">{new Date(item.confirmed_at??item.created_at).toLocaleString(language)}</div>
      <a className="mt-2 block break-all font-mono text-xs text-cyan-300 underline" href={`https://bscscan.com/tx/${item.tx_hash}`} target="_blank" rel="noreferrer">{item.tx_hash}</a>
    </div>)}</div>}
  </div>;
}
