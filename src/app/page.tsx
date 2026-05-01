'use client';

import { WelcomeWizard } from '@/components/welcome/wizard';

/**
 * v0.1.0 では Welcome ウィザードを default 表示する。
 * M1 後期に Welcome 完了フラグで Main shell へ遷移するルーティングを導入予定。
 */
export default function HomePage() {
  return (
    <main className="min-h-screen bg-background text-foreground">
      <WelcomeWizard />
    </main>
  );
}
