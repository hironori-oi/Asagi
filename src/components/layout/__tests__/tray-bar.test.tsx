/**
 * TrayBar tests (AS-UX-01 / DEC-018-037 §②)。
 *
 * Sumi DEC-053 翻訳である TrayBar の最小受入条件を検証する。
 *
 *   ① 初期表示で activeProject の model / effort が trigger label に反映される
 *   ② Effort radio の click で setEffort が発火し、store が更新される
 *
 * 詳細な Popover 開閉アニメーションや outside-click は Playwright @ux-traybar で扱う。
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import jaMessages from '@/lib/i18n/ja.json';
import { TrayBar } from '../tray-bar';
import { useChatStore } from '@/lib/stores/chat';
import { useProjectStore } from '@/lib/stores/project';

function renderWithIntl(ui: React.ReactElement) {
  return render(
    <NextIntlClientProvider locale="ja" messages={jaMessages} timeZone="Asia/Tokyo">
      {ui}
    </NextIntlClientProvider>
  );
}

describe('TrayBar', () => {
  beforeEach(() => {
    // 既知の activeProject を確保 (project store の seed されたダミーが入る)
    const projectId = useProjectStore.getState().activeProjectId;
    // chat store の per-project state をリセット
    useChatStore.setState({
      modelByProject: { [projectId]: 'gpt-5-codex' },
      effortByProject: { [projectId]: 'high' },
    });
  });

  it('① 初期表示で activeProject の model / effort 略号が trigger に反映される', () => {
    renderWithIntl(<TrayBar />);

    // model trigger に略号 "Codex 5" が表示される (gpt-5-codex の略)
    const modelPicker = screen.getByTestId('tray-model-picker');
    expect(within(modelPicker).getByText('Codex 5')).toBeInTheDocument();

    // effort trigger に "high" が表示される
    const effortPicker = screen.getByTestId('tray-effort-picker');
    expect(within(effortPicker).getByText('high')).toBeInTheDocument();
  });

  it('② Effort picker を開いて low を選択すると useChatStore.setEffort が反映される', async () => {
    const user = userEvent.setup();
    renderWithIntl(<TrayBar />);

    const effortPicker = screen.getByTestId('tray-effort-picker');
    const trigger = within(effortPicker).getByRole('button');
    await user.click(trigger);

    // popover 内の "low" radio をクリック
    const lowOption = screen.getByTestId('tray-effort-option-low');
    await user.click(lowOption);

    // store が更新される
    const projectId = useProjectStore.getState().activeProjectId;
    expect(useChatStore.getState().effortByProject[projectId]).toBe('low');
  });
});
