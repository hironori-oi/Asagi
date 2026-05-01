import { describe, it, expect, beforeEach } from 'vitest';
import { useLocaleStore, SUPPORTED_LOCALES } from '../locale';

function reset() {
  useLocaleStore.setState({ locale: 'ja' });
  if (typeof window !== 'undefined') {
    window.localStorage.removeItem('asagi-locale');
  }
}

describe('useLocaleStore', () => {
  beforeEach(reset);

  it('既定値は ja', () => {
    expect(useLocaleStore.getState().locale).toBe('ja');
  });

  it('SUPPORTED_LOCALES は ja/en の 2 件', () => {
    expect(SUPPORTED_LOCALES).toEqual(['ja', 'en']);
  });

  it('setLocale で en に変更できる', () => {
    useLocaleStore.getState().setLocale('en');
    expect(useLocaleStore.getState().locale).toBe('en');
  });
});
