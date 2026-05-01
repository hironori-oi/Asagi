import '@testing-library/jest-dom/vitest';
import { afterEach, vi } from 'vitest';
import { cleanup } from '@testing-library/react';

/**
 * 各テスト後にレンダリングされた DOM をクリーンアップ。
 * + framer-motion / next-themes / sonner などの副作用のリセット。
 */
afterEach(() => {
  cleanup();
});

// ---------------------------------------------------------------------------
// グローバルモック
// ---------------------------------------------------------------------------

// Tauri API: jsdom 上では undefined。コンポーネントが invoke を呼んでもクラッシュさせない。
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn().mockRejectedValue(new Error('tauri not available in test env')),
}));

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn().mockResolvedValue(() => {}),
  emit: vi.fn().mockResolvedValue(undefined),
}));

// matchMedia (next-themes / vaul で参照)
if (typeof window !== 'undefined' && !window.matchMedia) {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }),
  });
}

// IntersectionObserver (framer-motion / cmdk で参照)
if (typeof window !== 'undefined' && !('IntersectionObserver' in window)) {
  class MockIO {
    observe() {}
    unobserve() {}
    disconnect() {}
    takeRecords() {
      return [];
    }
  }
  // @ts-expect-error mock
  window.IntersectionObserver = MockIO;
}
