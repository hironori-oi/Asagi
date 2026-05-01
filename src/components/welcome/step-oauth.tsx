'use client';

import { useTranslations } from 'next-intl';
import { LogIn } from 'lucide-react';
import { Button } from '@/components/ui/button';

/**
 * Codex OAuth ログイン誘導ステップ（v0.1.0 ではスタブ）。
 * 本実装は AS-110 で `codex login` を Tauri Shell プラグインから spawn する。
 */
export function StepOAuth() {
  const t = useTranslations('welcome.oauth');

  const handleLoginStub = () => {
    // POC 通過後に置き換え:
    //   await invoke('auth_login_start');
    //   await on(AuthEvents.statusChanged, () => next());
    // 現状はスタブログ。
    // eslint-disable-next-line no-console
    console.log('[stub] codex login');
  };

  return (
    <section className="space-y-6">
      <div className="flex items-center gap-3">
        <div
          aria-hidden
          className="flex h-12 w-12 items-center justify-center rounded-xl bg-surface-elevated text-foreground"
        >
          <LogIn strokeWidth={1.5} className="h-6 w-6" />
        </div>
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{t('title')}</h1>
          <p className="text-sm text-muted-foreground">{t('subtitle')}</p>
        </div>
      </div>

      <p className="text-md leading-relaxed text-foreground/90">{t('body')}</p>

      <div className="rounded-lg border border-border bg-surface p-5">
        <Button onClick={handleLoginStub} className="w-full sm:w-auto" disabled>
          <LogIn strokeWidth={1.5} className="h-4 w-4" />
          {t('loginButton')}
        </Button>
        <p className="mt-3 text-xs text-muted-foreground">{t('note')}</p>
      </div>
    </section>
  );
}
