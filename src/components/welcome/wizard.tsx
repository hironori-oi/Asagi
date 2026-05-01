'use client';

import { motion, AnimatePresence } from 'framer-motion';
import { useTranslations } from 'next-intl';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useWelcomeStore } from '@/lib/stores/welcome';
import { StepBrand } from './step-brand';
import { StepOAuth } from './step-oauth';
import { StepPermissions } from './step-permissions';

const STEPS = [StepBrand, StepOAuth, StepPermissions];

export function WelcomeWizard() {
  const t = useTranslations('welcome');
  const { step, totalSteps, next, back, finish, completed } = useWelcomeStore();

  const StepComponent = STEPS[step] ?? StepBrand;
  const isFirst = step === 0;
  const isLast = step === totalSteps - 1;

  if (completed) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <p className="text-muted-foreground">
          Welcome 完了。Main shell は M1 後期で実装予定。
        </p>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen flex-col items-center justify-center px-6 py-12">
      <div className="w-full max-w-2xl">
        {/* ステップインジケータ */}
        <div className="mb-8 flex items-center justify-between">
          <span className="text-xs uppercase tracking-wider text-muted-foreground">
            {t('step', { current: step + 1, total: totalSteps })}
          </span>
          <div className="flex gap-1.5">
            {Array.from({ length: totalSteps }).map((_, i) => (
              <span
                key={i}
                className={
                  i === step
                    ? 'h-1.5 w-6 rounded-full bg-accent transition-colors duration-base ease-out-expo'
                    : 'h-1.5 w-1.5 rounded-full bg-border transition-colors duration-base ease-out-expo'
                }
              />
            ))}
          </div>
        </div>

        {/* ステップ本体 */}
        <AnimatePresence mode="wait">
          <motion.div
            key={step}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
          >
            <StepComponent />
          </motion.div>
        </AnimatePresence>

        {/* ナビゲーション */}
        <div className="mt-10 flex items-center justify-between">
          <Button
            variant="ghost"
            onClick={back}
            disabled={isFirst}
            aria-label={t('back')}
          >
            <ChevronLeft strokeWidth={1.5} className="h-4 w-4" />
            {t('back')}
          </Button>
          <Button onClick={isLast ? finish : next} aria-label={isLast ? t('finish') : t('next')}>
            {isLast ? t('finish') : t('next')}
            {!isLast && <ChevronRight strokeWidth={1.5} className="h-4 w-4" />}
          </Button>
        </div>
      </div>
    </div>
  );
}
