import { describe, it, expect } from 'vitest';
import { estimateTokens } from '../token-estimator';

describe('estimateTokens', () => {
  it('空文字は 0 を返す', () => {
    expect(estimateTokens('')).toBe(0);
  });

  it('1 word は ceil(1 * 1.3) = 2 を返す', () => {
    expect(estimateTokens('hello')).toBe(2);
  });

  it('多 word は ceil(n * 1.3) を返す', () => {
    // "hello world from codex" → 4 words → ceil(4 * 1.3) = 6
    expect(estimateTokens('hello world from codex')).toBe(6);
  });

  it('日本語のみは 1 文字 = 1 token として数える', () => {
    // "こんにちは" → 5 chars
    expect(estimateTokens('こんにちは')).toBe(5);
  });

  it('英語と日本語の mixed は両方を合算する', () => {
    // "Hello こんにちは" → 1 word + 5 cjk chars = ceil(1 * 1.3 + 5) = 7
    expect(estimateTokens('Hello こんにちは')).toBe(7);
  });
});
