'use client';

import { useTranslations } from 'next-intl';
import { Languages, Layers, Sparkles, Database } from 'lucide-react';

export function StepBrand() {
  const t = useTranslations('welcome.brand');

  const highlights = [
    { key: 'japanese', icon: Languages },
    { key: 'design', icon: Sparkles },
    { key: 'multiProject', icon: Layers },
    { key: 'local', icon: Database },
  ] as const;

  return (
    <section className="space-y-6">
      <div className="flex items-center gap-3">
        <div
          aria-hidden
          className="flex h-12 w-12 items-center justify-center rounded-xl bg-accent text-accent-foreground shadow-glow"
        >
          <span className="text-xl font-semibold">浅</span>
        </div>
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{t('title')}</h1>
          <p className="text-sm text-muted-foreground">{t('subtitle')}</p>
        </div>
      </div>

      <p className="text-md leading-relaxed text-foreground/90">{t('body')}</p>

      <div className="rounded-lg border border-border bg-surface p-5">
        <h2 className="mb-3 text-sm font-medium text-muted-foreground">
          {t('highlightTitle')}
        </h2>
        <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {highlights.map(({ key, icon: Icon }) => (
            <li key={key} className="flex items-start gap-2">
              <Icon strokeWidth={1.5} className="mt-0.5 h-4 w-4 text-accent" />
              <span className="text-sm">{t(`highlights.${key}`)}</span>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
