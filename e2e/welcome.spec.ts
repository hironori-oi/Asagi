import { test, expect } from '@playwright/test';

/**
 * Welcome ウィザードの E2E smoke (AS-META-03).
 *
 * - test1: ウィンドウ起動 → Welcome Step 1 が見える
 * - test2: 「次へ」を 2 回押すと Step 3 (StepSample) に到達
 * - test3: StepSample で "hello" 入力 → モック応答
 *
 * すべて smoke タグ付き。CI では `--grep @smoke` でこの 3 件のみ実行。
 */

test.beforeEach(async ({ context }) => {
  // Welcome 完了フラグをリセットして毎回 Step 1 から開始。
  await context.addInitScript(() => {
    try {
      localStorage.removeItem('asagi-welcome');
      localStorage.removeItem('asagi-locale');
    } catch {
      /* ignore */
    }
  });
});

test('@smoke Welcome Step 1 (Brand) が表示される', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByText('Asagi へようこそ')).toBeVisible();
  await expect(page.getByText(/1\s*\/\s*3/)).toBeVisible();
});

test('@smoke 「次へ」を 2 回押すと StepSample (Step 3) に到達', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: '次へ' }).click();
  await page.getByRole('button', { name: '次へ' }).click();
  await expect(page.getByText('サンプル体験')).toBeVisible();
  await expect(page.getByText(/3\s*\/\s*3/)).toBeVisible();
});

test('@smoke StepSample で hello 入力 → モック応答が表示', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: '次へ' }).click();
  await page.getByRole('button', { name: '次へ' }).click();

  const input = page.getByPlaceholder('例: こんにちは');
  await input.fill('hello');
  await input.press('Enter');

  // user メッセージが描画される (まず即時)
  await expect(page.getByText('hello').first()).toBeVisible();
  // 250ms 後にスタブ応答
  await expect(page.getByText(/\[stub\]/)).toBeVisible({ timeout: 2000 });
});
