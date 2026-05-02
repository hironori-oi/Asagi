/**
 * Sidebar tests (AS-UX-05 / DEC-018-037 §①)。
 *
 *   ① 初期 active tab = 'sessions'、tab click で activeTab state 更新
 *   ② collapsed トグルで data-collapsed 属性が変わる
 *   ③ activeTab は useUiStore に persist される（localStorage)
 *
 * Files / Runtime tab の中身は Tauri 依存のため別 spec or E2E で扱う。
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import jaMessages from '@/lib/i18n/ja.json';
import { Sidebar } from '../sidebar';
import { useUiStore } from '@/lib/stores/ui';

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
  it('① 初期表示で 3 つの tab が並び、activeTab=sessions が aria-selected=true', () => {
    renderWithIntl(<Sidebar />);

    const tabSessions = screen.getByTestId('sidebar-tab-sessions');
    const tabFiles = screen.getByTestId('sidebar-tab-files');
    const tabRuntime = screen.getByTestId('sidebar-tab-runtime');

    expect(tabSessions).toHaveAttribute('aria-selected', 'true');
    expect(tabFiles).toHaveAttribute('aria-selected', 'false');
    expect(tabRuntime).toHaveAttribute('aria-selected', 'false');
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

  it('③ collapsed=true で data-collapsed=true、tabpanel が非表示', () => {
    useUiStore.setState({ sidebarCollapsed: true });
    renderWithIntl(<Sidebar />);

    const sidebar = screen.getByTestId('sidebar');
    expect(sidebar).toHaveAttribute('data-collapsed', 'true');
    // collapsed 時は tabpanel 自体を render しない
    expect(screen.queryByTestId('sidebar-panel-sessions')).toBeNull();
    // tab buttons は依然見える
    expect(screen.getByTestId('sidebar-tab-sessions')).toBeInTheDocument();
  });
});
