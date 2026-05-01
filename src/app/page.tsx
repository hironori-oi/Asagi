'use client';

import { AppShell } from '@/components/layout/app-shell';

/**
 * Asagi v0.1.0 のエントリ。
 *
 * AppShell が `useWelcomeStore.completed` を見て:
 *   - false (初回起動) → WelcomeWizard 表示
 *   - true  (既存ユーザ) → 3 ペイン Main shell 表示
 * を切替える。
 */
export default function HomePage() {
  return <AppShell />;
}
