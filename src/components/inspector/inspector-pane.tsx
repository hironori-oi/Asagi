'use client';

/**
 * Main shell の右 Inspector ペイン雛形（320px）。
 * Reasoning effort gauge / Todos / SubAgents は M2 AS-221 で実装。
 */
export function InspectorPane() {
  return (
    <aside
      aria-label="Inspector"
      className="hidden w-80 flex-col border-l border-border bg-surface lg:flex"
    >
      <div className="border-b border-border p-4">
        <h2 className="text-sm font-medium">Inspector</h2>
        <p className="mt-1 text-xs text-muted-foreground">M2 AS-221 で実装</p>
      </div>
      <div className="flex-1 overflow-y-auto p-4 text-sm text-muted-foreground">
        Reasoning effort / Todos / SubAgents の表示エリア（雛形）
      </div>
    </aside>
  );
}
