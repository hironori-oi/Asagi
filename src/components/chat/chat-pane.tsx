'use client';

import { MessageList } from './message-list';
import { InputArea } from './input-area';

/**
 * Main shell の中央 Chat ペイン。
 *
 * v0.1.0:
 *   - MessageList（empty / list）+ InputArea（textarea + 送信 + モデル選択 + Reasoning effort）
 *   - 送信時は Zustand state にメッセージ追加 → モック応答
 *   - Codex sidecar 統合は POC 通過後（AS-122 / AS-123）に InputArea.send() を invoke 接続
 */
export function ChatPane() {
  return (
    <section
      aria-label="チャット"
      className="flex h-full min-w-0 flex-1 flex-col bg-background"
    >
      <MessageList />
      <InputArea />
    </section>
  );
}
