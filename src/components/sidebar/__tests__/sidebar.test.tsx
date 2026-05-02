/**
 * Sidebar tests (AS-UX-05 / AS-UX-11 / DEC-018-040)。
 *
 *   ① 初期 active tab = 'sessions'、4 タブ (Sessions/Files/Rules/Runtime) が並ぶ
 *   ② Files tab click で activeTab=files に切替・store も更新
 *   ③ Rules tab click で activeTab=rules に切替・tabpanel が rules
 *   ④ collapsed トグルで data-collapsed 属性が変わる
 *
 * Files / Rules / Runtime tab の中身は Tauri 依存のため別 spec or E2E で扱う。
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import jaMessages from '@/lib/i18n/ja.json';
import { Sidebar } from '../sidebar';
import { useUiStore } from '@/lib/stores/ui';

// RulesTab / FilesTab / RuntimeTab 内部の Tauri invoke を unit test では空 promise で
// 抑止する（Tauri 非接続環境でも render 自体は通る）。
vi.mock('@/lib/tauri/invoke', () => ({
  invoke: vi.fn().mockResolvedValue([]),
}));

function renderWithIntl(ui: React.ReactElement) {
  return render(
    <NextIntlClientProvider locale="ja" messages={jaMessages} timeZone="Asia/Tokyo">
      {ui}
    </NextIntlClientProvider>
  );
}

beforeEach(() => {
  // Sidebar state を 'sessions' / not collapsed に戻す
  useUiStore.setState({
    sidebarActiveTab: 'sessions',
    sidebarCollapsed: false,
  });
  if (typeof window !== 'undefined') {
    window.localStorage.removeItem('asagi-ui');
  }
});

describe('Sidebar', () => {
  it('① 初期表示で 4 つの tab (Sessions/Files/Rules/Runtime) が並び、activeTab=sessions が aria-selected=true', () => {
    renderWithIntl(<Sidebar />);

    const tabSessions = screen.getByTestId('sidebar-tab-sessions');
    const tabFiles = screen.getByTestId('sidebar-tab-files');
    const tabRules = screen.getByTestId('sidebar-tab-rules');
    const tabRuntime = screen.getByTestId('sidebar-tab-runtime');

    expect(tabSessions).toHaveAttribute('aria-selected', 'true');
    expect(tabFiles).toHaveAttribute('aria-selected', 'false');
    expect(tabRules).toHaveAttribute('aria-selected', 'false');
    expect(tabRuntime).toHaveAttribute('aria-selected', 'false');

    // role="tab" 全件で 4 件取得できる (WAI-ARIA tab pattern 維持)
    const allTabs = screen.getAllByRole('tab');
    expect(allTabs).toHaveLength(4);
  });

  it('② Files tab クリックで activeTab=files に切替・store も更新', async () => {
    const user = userEvent.setup();
    renderWithIntl(<Sidebar />);

    const tabFiles = screen.getByTestId('sidebar-tab-files');
    await user.click(tabFiles);

    expect(useUiStore.getState().sidebarActiveTab).toBe('files');
    expect(tabFiles).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByTestId('sidebar-panel-files')).toBeInTheDocument();
  });

  it('③ Rules tab クリックで activeTab=rules に切替・rules tabpanel が表示', async () => {
    const user = userEvent.setup();
    renderWithIntl(<Sidebar />);

    const tabRules = screen.getByTestId('sidebar-tab-rules');
    await user.click(tabRules);

    expect(useUiStore.getState().sidebarActiveTab).toBe('rules');
    expect(tabRules).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByTestId('sidebar-panel-rules')).toBeInTheDocument();
  });

  it('④ collapsed=true で data-collapsed=true、tabpanel が非表示', () => {
    useUiStore.setState({ sidebarCollapsed: true });
    renderWithIntl(<Sidebar />);

    const sidebar = screen.getByTestId('sidebar');
    expect(sidebar).toHaveAttribute('data-collapsed', 'true');
    // collapsed 時は tabpanel 自体を render しない
    expect(screen.queryByTestId('sidebar-panel-sessions')).toBeNull();
    // tab buttons は依然見える (4 タブとも)
    expect(screen.getByTestId('sidebar-tab-sessions')).toBeInTheDocument();
    expect(screen.getByTestId('sidebar-tab-files')).toBeInTheDocument();
    expect(screen.getByTestId('sidebar-tab-rules')).toBeInTheDocument();
    expect(screen.getByTestId('sidebar-tab-runtime')).toBeInTheDocument();
  });
});
