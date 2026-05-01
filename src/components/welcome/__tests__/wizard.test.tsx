import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import jaMessages from '@/lib/i18n/ja.json';
import { WelcomeWizard } from '../wizard';
import { useWelcomeStore } from '@/lib/stores/welcome';

/**
 * WelcomeWizard のレンダーテスト (AS-META-02)。
 *
 * - 初回 (completed=false) でステップインジケータが描画されること
 * - completed=true で「Welcome 完了」プレースホルダが表示されること
 */

function renderWithIntl(ui: React.ReactElement) {
  return render(
    <NextIntlClientProvider locale="ja" messages={jaMessages} timeZone="Asia/Tokyo">
      {ui}
    </NextIntlClientProvider>
  );
}

describe('WelcomeWizard', () => {
  beforeEach(() => {
    useWelcomeStore.setState({ step: 0, completed: false });
    if (typeof window !== 'undefined') {
      window.localStorage.removeItem('asagi-welcome');
    }
  });

  it('未完了時に Step 1 のタイトル「Asagi へようこそ」が表示される', () => {
    renderWithIntl(<WelcomeWizard />);
    expect(screen.getByText(/Asagi へようこそ/)).toBeInTheDocument();
  });

  it('未完了時に「次へ」ボタンが表示される', () => {
    renderWithIntl(<WelcomeWizard />);
    const nextButtons = screen.getAllByText(/次へ/);
    expect(nextButtons.length).toBeGreaterThan(0);
  });

  it('completed=true でプレースホルダ表示', () => {
    useWelcomeStore.setState({ step: 0, completed: true });
    renderWithIntl(<WelcomeWizard />);
    expect(screen.getByText(/Welcome 完了/)).toBeInTheDocument();
  });
});
