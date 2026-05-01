'use client';

import { useTranslations } from 'next-intl';
import { LogIn, Cpu, Database, KeyRound, EyeOff } from 'lucide-react';
import { Button } from '@/components/ui/button';

/**
 * Welcome Step 2: OAuth ログイン誘導 + パーミッション説明（AS-119）。
 *
 * 旧 step-permissions の内容（必要なアクセス領域）も合流させ、
 * ChatGPT サブスクログインとプライバシーを 1 ステップで提示する。
 */
export function StepOAuth() {
  const t = useTranslations('welcome.oauth');

  const permissions = [
    { key: 'codexProcess', icon: Cpu },
    { key: 'localDb', icon: Database },
    { key: 'keyring', icon: KeyRound },
    { key: 'noTelemetry', icon: EyeOff },
  ] as const;

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

      <div className="rounded-lg border border-border bg-surface p-5">
        <h2 className="mb-3 text-sm font-medium text-muted-foreground">
          {t('permissionsTitle')}
        </h2>
        <ul className="space-y-2">
          {permissions.map(({ key, icon: Icon }) => (
            <li key={key} className="flex items-start gap-3">
              <Icon strokeWidth={1.5} className="mt-0.5 h-4 w-4 text-accent" />
              <span className="text-sm leading-relaxed">{t(`permissions.${key}`)}</span>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
