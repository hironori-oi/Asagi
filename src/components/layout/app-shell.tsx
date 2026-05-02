'use client';

import { useEffect } from 'react';
import { useWelcomeStore } from '@/lib/stores/welcome';
import { useSidecarModeStore } from '@/lib/stores/sidecar-mode';
import { WelcomeWizard } from '@/components/welcome/wizard';
import { TitleBar } from './title-bar';
import { TrayBar } from './tray-bar';
import { StatusBar } from './status-bar';
import { ProjectRail } from '@/components/project-rail/project-rail';
import { ChatPane } from '@/components/chat/chat-pane';
import { Sidebar } from '@/components/sidebar/sidebar';
import { CommandPalette } from '@/components/command-palette/command-palette';
import { SettingsDrawer } from '@/components/settings/settings-drawer';
import { HelpDialog } from '@/components/help/help-dialog';
import { GlobalKeybindings } from '@/components/keybindings/global-keybindings';

/**
 * AppShell — Asagi 全体のシェル（AS-108 / AS-114 / AS-117 / AS-118 / AS-120 / AS-121 / AS-UX-11）。
 *
 * 初回起動時（welcome.completed === false）は WelcomeWizard を表示し、
 * 完了後は 3 ペイン（左 Rail+Sidebar / 中央 Chat、右 Inspector は AS-UX-11 で撤去済）の
 * Main shell に切替える。Inspector の責務は Sidebar 4 タブ（Sessions/Files/Rules/Runtime）に
 * 統合（DEC-018-040）。ChatPane は flex-1 で残余幅を占有する。
 *
 * グローバル overlay（CommandPalette / SettingsDrawer / HelpDialog）と
 * GlobalKeybindings は Welcome 完了前後に関わらず常時マウントする。
 *
 * 設計参照: design-brand-v1.md § 5.1 グローバル構造 / § 6.4 Command Palette
 */
export function AppShell() {
  const completed = useWelcomeStore((s) => s.completed);
  const refreshSidecarMode = useSidecarModeStore((s) => s.refresh);

  // AS-144 / DEC-018-036: 起動時に backend から現 sidecar mode を seed する。
  // 失敗時は store 内で `mock` fallback されるため UI は常に動作する。
  useEffect(() => {
    void refreshSidecarMode();
  }, [refreshSidecarMode]);

  return (
    <>
      {!completed ? (
        <main className="flex min-h-screen flex-col bg-background text-foreground">
          <TitleBar />
          <div className="flex flex-1 items-center justify-center">
            <WelcomeWizard />
          </div>
          <StatusBar />
        </main>
      ) : (
        <main className="flex h-screen flex-col bg-background text-foreground">
          <TitleBar />
          <TrayBar />
          <div className="flex min-h-0 flex-1">
            <ProjectRail />
            <Sidebar />
            <ChatPane />
          </div>
          <StatusBar />
        </main>
      )}
      <GlobalKeybindings />
      <CommandPalette />
      <SettingsDrawer />
      <HelpDialog />
    </>
  );
}
