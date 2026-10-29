'use client';

import { localizedPair } from '@/lib/ui-localization';
import { useEffect, useState } from 'react';
import { useAccount } from 'wagmi';
import {useBusinessAccount} from '@/components/useBusinessAccount';
import Navbar from '@/components/Navbar';
import BackendAccount from '@/components/BackendAccount';
import { useLanguage } from '@/components/LanguageProvider';
import { getLockedReferrer, lockReferrer } from '@/lib/ledger';

export default function RecordsPage() {
  const { t, language } = useLanguage();
  const zh=language.startsWith('zh');
  const { address } = useAccount();
  const [, setProfileError] = useState('');
  const business=useBusinessAccount({autoAuthorize:true});
  const [profile, setProfile] = useState<{teamCount:number;miningDirectReferrals:number;miningTeamPerformanceUsdt:string;referrerWallet:string|null;directReferrals:number;maxGenerations:number;upperUnlocked:boolean}>();
  const [inviteCopied, setInviteCopied] = useState(false);

  useEffect(() => {
    setProfile(undefined); setProfileError('');
    if (!address) return;
    const controller = new AbortController(); const signal = controller.signal;
    const ref = new URLSearchParams(window.location.search).get('ref');
    if (ref && /^0x[a-fA-F0-9]{40}$/.test(ref) && !getLockedReferrer() && ref.toLowerCase() !== address.toLowerCase()) lockReferrer(ref);
    setProfileError('');
    let refreshSequence=0;
    const refreshProfile=()=>{
      const current=++refreshSequence;
    fetch('/api/user/profile',{signal,method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({walletAddress:address,referrerWallet:ref || getLockedReferrer()})})
      .then(async r=>{ const data=await r.json(); if(!r.ok) throw new Error(data.error || 'Unable to load referral profile'); return data; })
      .then(data=>{if(!signal.aborted&&current===refreshSequence){setProfile(data);setProfileError('');}})
      .catch(e=>{if (!signal.aborted) setProfileError(e instanceof Error ? e.message : 'Unable to load referral profile');});
    };
    refreshProfile();const timer=window.setInterval(refreshProfile,15000);
    return () => { controller.abort();window.clearInterval(timer); };
  }, [address]);

  const inviteLink = typeof window !== 'undefined' && address ? window.location.origin + '/?ref=' + address : '';
  const copyInvite = async () => { if (!inviteLink) return; await navigator.clipboard?.writeText(inviteLink); setInviteCopied(true); window.setTimeout(()=>setInviteCopied(false),1600); };


  return <main className="min-h-screen pbm-shell"><Navbar /><div className="lg:ml-[248px]"><div className="mx-auto max-w-6xl px-4 py-7 sm:px-6 sm:py-10">
    <a href="/" className="text-sm text-slate-500 hover:text-cyan-300">← {t.backHome}</a>
    <section className="pbm-panel pbm-glow pbm-page-enter relative mt-5 overflow-hidden p-5 sm:p-8">
      <div className="text-xs uppercase tracking-[.2em] text-cyan-300">PBM / {t.myEyebrow}</div><p className="mt-2 text-sm text-slate-400">{localizedPair(language, "资产、矿储团队", "Assets and mining team")}</p>
      <div className="mt-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <div className="pbm-panel bg-[#020a1b]/60 p-5"><div className="text-xs text-slate-500">{t.teamMembers}</div><div className="mt-2 text-3xl font-black">{profile?.teamCount ?? '—'}</div></div>
        <div className="pbm-panel bg-[#020a1b]/60 p-5"><div className="text-xs text-slate-500">{localizedPair(language, '矿储总额', 'Total mining reserve')}</div><div className="mt-2 break-all text-3xl font-black">{profile?.miningTeamPerformanceUsdt??'—'} <span className="text-sm text-cyan-300">USDT</span></div></div>
        <div className="pbm-panel bg-[#020a1b]/60 p-5"><div className="text-xs text-slate-500">{localizedPair(language, '矿储部门', 'Mining department')}</div><div className="mt-2 text-3xl font-black">{profile?.miningDirectReferrals??'—'}</div></div>
      </div>
    </section>

    <BackendAccount authorizedWallet={business.snapshot?.walletAddress} />{business.busy&&<p className="mt-5 text-sm text-slate-400">{localizedPair(language, '正在加载账户…', 'Loading account…')}</p>}{!business.busy&&business.canLoad&&(business.needsAuthorization||business.error)&&<button className="pbm-btn pbm-btn-secondary mt-5" onClick={business.load}>{localizedPair(language, '重新连接账户', 'Reconnect account')}</button>}{business.error&&<p className="mt-2 text-sm text-rose-300">{business.error}</p>}

    <section className="mt-5">
      <div className="pbm-panel p-5 sm:p-7"><div className="text-xs uppercase tracking-[.2em] text-purple-300">{t.referralTitle}</div>
        <div className="mt-4 flex gap-5 flex-col sm:flex-row sm:items-center"><div className="grid h-40 w-40 shrink-0 place-items-center rounded-2xl border border-cyan-400/20 bg-white p-2"><img src={inviteLink ? 'https://quickchart.io/qr?size=180&text='+encodeURIComponent(inviteLink) : '/icon.svg'} alt="PBMReserves referral QR" className="h-full w-full object-contain" /></div>
        <div className="min-w-0 flex-1"><div className="text-xs text-slate-500">{t.myReferralLink}</div><div className="mt-2 break-all rounded-xl border border-blue-900/60 bg-[#020817] p-3 font-mono text-xs text-cyan-100">{inviteLink || t.connectFirst}</div><button type="button" onClick={copyInvite} className="pbm-btn pbm-btn-secondary mt-3 w-full">{inviteCopied?t.copied:t.copyReferral}</button></div></div>
      </div>

    </section>


  </div></div></main>;
}
