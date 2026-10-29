'use client';

import { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { LANGUAGES, translations, type LanguageKey } from '@/config/i18n';

type Ctx = {
  language: LanguageKey;
  setLanguage: (language: LanguageKey) => void;
  t: (typeof translations)[LanguageKey];
};

const LanguageContext = createContext<Ctx | null>(null);

function isLanguageKey(value: string | null): value is LanguageKey {
  return !!value && LANGUAGES.some((item) => item.key === value);
}

export default function LanguageProvider({ children }: { children: React.ReactNode }) {
  const [language, setLanguageState] = useState<LanguageKey>('en');

  useEffect(() => {
    try {
      const saved = window.localStorage.getItem('pbm-language');
      if (isLanguageKey(saved)) setLanguageState(saved);
    } catch {
      // Storage may be disabled by browser privacy settings; keep the in-memory locale usable.
    }
  }, []);

  useEffect(() => {
    document.documentElement.lang = language;
  }, [language]);

  useEffect(() => {
    const syncLanguage = (event: StorageEvent) => {
      if (event.key === 'pbm-language' && isLanguageKey(event.newValue)) {
        setLanguageState(event.newValue);
      }
    };
    window.addEventListener('storage', syncLanguage);
    return () => window.removeEventListener('storage', syncLanguage);
  }, []);

  function setLanguage(next: LanguageKey) {
    setLanguageState(next);
    try {
      window.localStorage.setItem('pbm-language', next);
    } catch {
      // Locale switching still works for the current page when persistence is unavailable.
    }
    document.documentElement.lang = next;
  }

  const value = useMemo(() => ({ language, setLanguage, t: translations[language] }), [language]);
  return <LanguageContext.Provider value={value}>{children}</LanguageContext.Provider>;
}

export function useLanguage() {
  const ctx = useContext(LanguageContext);
  if (!ctx) throw new Error('useLanguage must be used inside LanguageProvider');
  return ctx;
}
