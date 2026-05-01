'use client';

/**
 * Main shell の中央 Chat ペイン雛形。
 * v0.1.0 では UI の枠だけ用意。Codex sidecar 統合は AS-122 / AS-123（POC 通過後）。
 */
export function ChatPane() {
  return (
    <section
      aria-label="チャット"
      className="flex h-full flex-1 flex-col bg-background"
    >
      <div className="flex-1 overflow-y-auto p-6">
        <p className="text-sm text-muted-foreground">
          チャット領域（POC 通過後に Codex 統合を実装）
        </p>
      </div>
      <div className="border-t border-border bg-surface p-4">
        <textarea
          aria-label="メッセージ入力"
          placeholder="POC 通過後に有効化されます"
          disabled
          rows={2}
          className="w-full resize-none rounded-md border border-border bg-surface-elevated px-3 py-2 text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
      </div>
    </section>
  );
}
