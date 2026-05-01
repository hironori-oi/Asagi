'use client';

import { useWelcomeStore } from '@/lib/stores/welcome';
import { WelcomeWizard } from '@/components/welcome/wizard';
import { TitleBar } from './title-bar';
import { StatusBar } from './status-bar';
import { ProjectRail } from '@/components/project-rail/project-rail';
import { ChatPane } from '@/components/chat/chat-pane';
import { Inspector } from '@/components/inspector/inspector';

/**
 * AppShell — Asagi 全体のシェル。
 *
 * 初回起動時（welcome.completed === false）は WelcomeWizard を表示し、
 * 完了後は 3 ペイン（左 Rail+Sidebar / 中央 Chat / 右 Inspector）の Main shell に切替える。
 *
 * 設計参照: design-brand-v1.md § 5.1 グローバル構造
 */
export function AppShell() {
  const completed = useWelcomeStore((s) => s.completed);

  if (!completed) {
    return (
      <main className="flex min-h-screen flex-col bg-background text-foreground">
        <TitleBar />
        <div className="flex flex-1 items-center justify-center">
          <WelcomeWizard />
        </div>
        <StatusBar />
      </main>
    );
  }

  return (
    <main className="flex h-screen flex-col bg-background text-foreground">
      <TitleBar />
      <div className="flex min-h-0 flex-1">
        <ProjectRail />
        <Sidebar />
        <ChatPane />
        <Inspector />
      </div>
      <StatusBar />
    </main>
  );
}

/**
 * 240px の Sidebar 雛形。SessionList / モデル切替は M1 後期 / M2 で本実装。
 * AS-108 では枠だけ提供して 3 ペイン構造を視認可能にする。
 */
function Sidebar() {
  return (
    <aside
      aria-label="サイドバー"
      className="hidden w-60 shrink-0 flex-col border-r border-border bg-surface md:flex"
    >
      <div className="border-b border-border p-3">
        <h2 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
          セッション
        </h2>
      </div>
      <div className="flex-1 overflow-y-auto p-3 text-sm text-muted-foreground">
        <p className="rounded-md border border-dashed border-border p-3 text-xs">
          セッション一覧はここに表示されます（AS-129 で SQLite から hydration 予定）。
        </p>
      </div>
    </aside>
  );
}
