'use client';

import { useTranslations } from 'next-intl';
import { ShieldCheck, Cpu, Database, KeyRound, EyeOff } from 'lucide-react';

export function StepPermissions() {
  const t = useTranslations('welcome.permissions');

  const items = [
    { key: 'codexProcess', icon: Cpu },
    { key: 'localDb', icon: Database },
    { key: 'keyring', icon: KeyRound },
    { key: 'noTelemetry', icon: EyeOff },
  ] as const;

  return (
    <section className="space-y-6">
      <div className="flex items-center gap-3">
        <div
          aria-hidden
          className="flex h-12 w-12 items-center justify-center rounded-xl bg-surface-elevated text-accent"
        >
          <ShieldCheck strokeWidth={1.5} className="h-6 w-6" />
        </div>
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{t('title')}</h1>
          <p className="text-sm text-muted-foreground">{t('subtitle')}</p>
        </div>
      </div>

      <ul className="space-y-2 rounded-lg border border-border bg-surface p-5">
        {items.map(({ key, icon: Icon }) => (
          <li key={key} className="flex items-start gap-3">
            <Icon strokeWidth={1.5} className="mt-0.5 h-4 w-4 text-accent" />
            <span className="text-sm leading-relaxed">{t(`items.${key}`)}</span>
          </li>
        ))}
      </ul>

      <div className="rounded-lg border border-border bg-surface-elevated p-5">
        <h2 className="text-sm font-medium">{t('sampleTitle')}</h2>
        <p className="mt-2 text-sm text-muted-foreground">{t('sampleBody')}</p>
      </div>
    </section>
  );
}
