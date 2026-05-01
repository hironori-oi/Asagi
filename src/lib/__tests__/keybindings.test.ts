import { describe, it, expect } from 'vitest';
import { KEYBINDINGS, formatHotkey } from '../keybindings';

describe('KEYBINDINGS', () => {
  it('必須エントリが揃っている', () => {
    expect(KEYBINDINGS.commandPalette).toBe('mod+k');
    expect(KEYBINDINGS.toggleTheme).toBe('mod+t');
    expect(KEYBINDINGS.newSession).toBe('mod+n');
    expect(KEYBINDINGS.showHelp).toBe('mod+/');
  });
});

describe('formatHotkey', () => {
  it('mod を Ctrl/Cmd に変換する', () => {
    const formatted = formatHotkey('mod+k');
    // navigator.platform は jsdom では空文字 → デフォルト Ctrl
    expect(formatted).toMatch(/^(Ctrl|Cmd) \+ K$/);
  });

  it('複数キー結合が動作する', () => {
    const formatted = formatHotkey('mod+shift+f');
    expect(formatted).toMatch(/Shift/);
    expect(formatted).toMatch(/F/);
  });
});
