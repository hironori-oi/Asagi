'use client';

import { useEffect, useMemo, useState } from 'react';
import { NextIntlClientProvider, type AbstractIntlMessages } from 'next-intl';
import jaMessages from '@/lib/i18n/ja.json';
import enMessages from '@/lib/i18n/en.json';
import { useLocaleStore, type Locale } from '@/lib/stores/locale';

const MESSAGES: Record<Locale, AbstractIntlMessages> = {
  ja: jaMessages as AbstractIntlMessages,
  en: enMessages as AbstractIntlMessages,
};

/**
 * クライアントサイドの IntlProvider。
 *
 * - 初回 SSR 時は ja で render（hydration mismatch 回避）
 * - mount 後に store の locale を反映 → ユーザの選好で動的に切替
 * - locale 切替は `useLocaleStore.setLocale()` を介してリアクティブに反映
 */
export function ClientIntlProvider({ children }: { children: React.ReactNode }) {
  const storedLocale = useLocaleStore((s) => s.locale);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  const effectiveLocale: Locale = mounted ? storedLocale : 'ja';
  const messages = useMemo(() => MESSAGES[effectiveLocale], [effectiveLocale]);

  // <html lang> も追従させる
  useEffect(() => {
    if (mounted && typeof document !== 'undefined') {
      document.documentElement.setAttribute('lang', effectiveLocale);
    }
  }, [effectiveLocale, mounted]);

  return (
    <NextIntlClientProvider
      locale={effectiveLocale}
      messages={messages}
      timeZone="Asia/Tokyo"
    >
      {children}
    </NextIntlClientProvider>
  );
}
