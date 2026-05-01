import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import path from 'node:path';

/**
 * Vitest 設定 (AS-META-02)。
 *
 * - jsdom で React Testing Library を使えるようにする
 * - tsconfig の path alias (@/...) を vite-side で解決
 * - setupFiles で `cleanup` の wiring
 * - Tauri 側 (src-tauri/) は cargo test で個別に回す
 */
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./vitest.setup.ts'],
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
    exclude: [
      'node_modules/**',
      '.next/**',
      'out/**',
      'src-tauri/**',
      'e2e/**',
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['src/lib/**/*.{ts,tsx}', 'src/components/**/*.{ts,tsx}'],
      exclude: [
        'src/lib/i18n/**',
        'src/**/__tests__/**',
        'src/**/*.{test,spec}.{ts,tsx}',
      ],
    },
  },
});
