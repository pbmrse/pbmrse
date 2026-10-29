'use client';
import { localizedPair } from '@/lib/ui-localization';
import { WalletBalanceCards } from './TokenBalances';
import { useLanguage } from './LanguageProvider';

export default function BackendAccount({ authorizedWallet: _authorizedWallet }: { authorizedWallet?: string }) {
  const { language } = useLanguage();
  return (
    <section className="mt-5 pbm-panel p-5 sm:p-7">
      <h3 className="mt-5 mb-2 text-sm font-semibold text-cyan-200">
        {localizedPair(language, '钱包余额', 'Wallet balances')}
      </h3>
      <WalletBalanceCards />
    </section>
  );
}
