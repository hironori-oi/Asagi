/**
 * RulesTab tests (AS-UX-11.3 / DEC-018-040 ③)。
 *
 *   ① mock invoke が CLAUDE.md を返すと検出行が表示され、AGENTS.md/CODEX.md は
 *      「未検出」placeholder が表示される
 *   ② mock invoke が空配列を返すと候補 3 件すべて未検出 placeholder が表示され、
 *      empty メッセージも併記される
 *   ③ refresh button click で再 invoke が走る (回数で検証)
 *
 * Tauri 接続 / list_dir Rust 実装は E2E (`ux-sidebar-rules.spec.ts`) で検証する。
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import jaMessages from '@/lib/i18n/ja.json';
import { RulesTab } from '../rules-tab';
import { useProjectStore } from '@/lib/stores/project';
import { invoke } from '@/lib/tauri/invoke';

vi.mock('@/lib/tauri/invoke', () => ({
  invoke: vi.fn(),
}));

const invokeMock = vi.mocked(invoke);

function renderWithIntl(ui: React.ReactElement) {
  return render(
    <NextIntlClientProvider locale="ja" messages={jaMessages} timeZone="Asia/Tokyo">
      {ui}
    </NextIntlClientProvider>,
  );
}

beforeEach(() => {
  invokeMock.mockReset();
  // 既知のダミープロジェクト (default-asagi) を active 状態に
  useProjectStore.setState({
    activeProjectId: 'default-asagi',
  });
  if (typeof window !== 'undefined') {
    window.localStorage.removeItem('asagi-project-registry');
  }
});

describe('RulesTab', () => {
  it('① CLAUDE.md 検出時: claude.md は実体行、agents.md / codex.md は「未検出」placeholder', async () => {
    invokeMock.mockResolvedValueOnce([
      { name: 'CLAUDE.md', path: '/mock/CLAUDE.md', kind: 'file', size: 4242 },
      { name: 'package.json', path: '/mock/package.json', kind: 'file', size: 100 },
      { name: 'src', path: '/mock/src', kind: 'dir', size: null },
    ]);

    renderWithIntl(<RulesTab />);

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith(
        'list_dir',
        expect.objectContaining({ args: expect.objectContaining({ path: expect.any(String) }) }),
      );
    });

    // 3 候補が並ぶ
    const claudeRow = await screen.findByTestId('rules-row-claude.md');
    const agentsRow = screen.getByTestId('rules-row-agents.md');
    const codexRow = screen.getByTestId('rules-row-codex.md');

    // CLAUDE.md は present=true、ファイルサイズ表示
    expect(claudeRow).toHaveAttribute('data-present', 'true');
    expect(claudeRow).toHaveTextContent('CLAUDE.md');
    expect(claudeRow).toHaveTextContent('4242 B');

    // 残り 2 件は present=false、未検出文言
    expect(agentsRow).toHaveAttribute('data-present', 'false');
    expect(agentsRow).toHaveTextContent('未検出');
    expect(codexRow).toHaveAttribute('data-present', 'false');
    expect(codexRow).toHaveTextContent('未検出');
  });

  it('② 全候補未検出時: empty メッセージ + 3 行とも未検出 placeholder', async () => {
    invokeMock.mockResolvedValueOnce([
      { name: 'README.md', path: '/mock/README.md', kind: 'file', size: 100 },
    ]);

    renderWithIntl(<RulesTab />);

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalled();
    });

    // empty メッセージ表示
    expect(
      await screen.findByText('プロジェクトルートに規約ファイルがありません'),
    ).toBeInTheDocument();

    // 3 行とも present=false
    for (const candidate of ['claude.md', 'agents.md', 'codex.md']) {
      const row = screen.getByTestId(`rules-row-${candidate}`);
      expect(row).toHaveAttribute('data-present', 'false');
      expect(row).toHaveTextContent('未検出');
    }
  });

  it('③ refresh ボタン click で list_dir が再 invoke される', async () => {
    invokeMock.mockResolvedValue([
      { name: 'CLAUDE.md', path: '/mock/CLAUDE.md', kind: 'file', size: 1 },
    ]);
    const user = userEvent.setup();

    renderWithIntl(<RulesTab />);

    await waitFor(() => expect(invokeMock).toHaveBeenCalledTimes(1));

    const refresh = screen.getByTestId('rules-refresh');
    await user.click(refresh);

    await waitFor(() => expect(invokeMock).toHaveBeenCalledTimes(2));
    expect(invokeMock).toHaveBeenLastCalledWith(
      'list_dir',
      expect.objectContaining({ args: expect.objectContaining({ path: expect.any(String) }) }),
    );
  });
});
