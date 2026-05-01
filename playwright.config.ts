import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright 設定 (AS-META-03)。
 *
 * - Chromium のみ (Tauri WebView2 互換性確認用 / Linux/Win/macOS の WebKit/Gecko は本実装で対応)
 * - webServer で `npm run dev` を自動起動
 * - smoke タグで CI フィルタ
 *
 * 完全な Tauri E2E (実 binary 起動) は M2 で `tauri-driver` + WebDriver IO 導入予定。
 */
export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: 'http://localhost:3000',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: {
    command: 'npm run dev',
    url: 'http://localhost:3000',
    reuseExistingServer: !process.env.CI,
    timeout: 120 * 1000,
  },
});
