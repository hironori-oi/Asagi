import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';

export type Locale = 'ja' | 'en';

export const SUPPORTED_LOCALES: readonly Locale[] = ['ja', 'en'] as const;

interface LocaleState {
  locale: Locale;
  setLocale: (locale: Locale) => void;
}

/**
 * UI ロケールの永続化（AS-118）。
 *
 * - 既定値は `ja`（日本語 UI ファースト方針 / DEC-018-006 A 軸）
 * - 切替は設定 dropdown から行い、即座に反映する（`NextIntlClientProvider` の messages を更新）
 * - localStorage に persist し、再起動後も維持
 */
export const useLocaleStore = create<LocaleState>()(
  persist(
    (set) => ({
      locale: 'ja',
      setLocale: (locale) => set({ locale }),
    }),
    {
      name: 'asagi-locale',
      storage: createJSONStorage(() => {
        if (typeof window === 'undefined') {
          return {
            getItem: () => null,
            setItem: () => {},
            removeItem: () => {},
          };
        }
        return window.localStorage;
      }),
      version: 1,
    }
  )
);
