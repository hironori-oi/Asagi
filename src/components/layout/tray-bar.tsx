'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { AnimatePresence, motion } from 'framer-motion';
import { Cpu, Gauge, Check, ChevronDown } from 'lucide-react';
import { useProjectStore } from '@/lib/stores/project';
import {
  useChatStore,
  CHAT_DEFAULT_MODEL,
  CHAT_DEFAULT_EFFORT,
  type ReasoningEffort,
} from '@/lib/stores/chat';
import { invoke } from '@/lib/tauri/invoke';
import { cn } from '@/lib/utils';

const FALLBACK_MODELS = ['gpt-5.5-codex', 'gpt-5-codex', 'o4-mini'];
const EFFORTS: ReasoningEffort[] = ['low', 'medium', 'high'];

/**
 * TrayBar — TitleBar 直下の 32px 高 picker 集約バー（AS-UX-01 / DEC-018-037 §②）。
 *
 * Sumi DEC-053 の翻訳実装。Model / Effort の picker を InputArea から TrayBar に移し、
 * チャット入力欄の認知負荷を下げ、設定系コントロールを上部に集約する。
 *
 * 構成:
 *   - 左側: Model picker（Cpu icon + 略号 + Popover-radiogroup）
 *   - 左側: Effort picker（Gauge icon + 略号 + Popover-radiogroup、各 option = label + 説明）
 *   - 右側: PermissionMode picker 用の予約スロット（M2 で実装、DEC-018-037 §③ Won't）
 *
 * a11y:
 *   - trigger button は aria-haspopup / aria-expanded を持つ
 *   - Popover 内 radio は role="radio" / aria-checked
 *   - Tab 移動可 / Enter / Space で開閉 / Esc で閉じる
 *
 * モーション: open/close 150ms ease-out（Sumi 哲学 § 4.4 準拠）
 *
 * 浅葱 accent: 選択中 radio item の text/border は `--accent`（oklch(0.72 0.10 200)）。
 * Anthropic オレンジには置換しない（DEC-018-037 §⑤）。
 */
export function TrayBar() {
  const t = useTranslations('shell.traybar');

  const activeId = useProjectStore((s) => s.activeProjectId);
  const model = useChatStore((s) => s.modelByProject[activeId] ?? CHAT_DEFAULT_MODEL);
  const effort = useChatStore((s) => s.effortByProject[activeId] ?? CHAT_DEFAULT_EFFORT);
  const setModel = useChatStore((s) => s.setModel);
  const setEffort = useChatStore((s) => s.setEffort);

  const [models, setModels] = useState<string[]>(FALLBACK_MODELS);

  useEffect(() => {
    let cancelled = false;
    invoke<string[]>('codex_get_models')
      .then((list) => {
        if (!cancelled && Array.isArray(list) && list.length > 0) setModels(list);
      })
      .catch(() => {
        if (!cancelled) setModels(FALLBACK_MODELS);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div
      role="toolbar"
      aria-label={t('label')}
      data-testid="tray-bar"
      className={cn(
        'flex h-8 shrink-0 items-center gap-2 border-b border-border bg-surface px-3',
        'text-[11px] text-muted-foreground'
      )}
    >
      <ModelPicker
        value={model}
        models={models}
        onChange={(v) => setModel(activeId, v)}
        labelText={t('model.label')}
        ariaLabel={t('model.aria')}
      />
      <EffortPicker
        value={effort}
        onChange={(v) => setEffort(activeId, v)}
        ariaLabel={t('effort.aria')}
        triggerLabel={t('effort.label')}
        options={{
          low: { label: t('effort.options.low.label'), desc: t('effort.options.low.desc') },
          medium: { label: t('effort.options.medium.label'), desc: t('effort.options.medium.desc') },
          high: { label: t('effort.options.high.label'), desc: t('effort.options.high.desc') },
        }}
      />
      {/*
        TODO(M2 / AS-UX-10): PermissionMode picker をここに追加する（DEC-018-037 §③ Won't）。
        右端配置のため `ml-auto` を持つラッパで囲む予定。
      */}
      <span className="ml-auto" aria-hidden />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Model Picker
// ---------------------------------------------------------------------------

interface ModelPickerProps {
  value: string;
  models: string[];
  onChange: (v: string) => void;
  labelText: string;
  ariaLabel: string;
}

function ModelPicker({ value, models, onChange, labelText, ariaLabel }: ModelPickerProps) {
  return (
    <PickerPopover
      ariaLabel={ariaLabel}
      testId="tray-model-picker"
      trigger={
        <span className="flex items-center gap-1.5">
          <Cpu strokeWidth={1.5} className="h-3.5 w-3.5 text-accent" />
          <span className="hidden md:inline text-muted-foreground">{labelText}:</span>
          <span className="text-foreground/85 font-medium">{abbreviateModel(value)}</span>
          <ChevronDown strokeWidth={1.5} className="h-3 w-3 opacity-60" />
        </span>
      }
    >
      {(close) => (
        <div role="radiogroup" aria-label={ariaLabel} className="flex flex-col py-1">
          {models.map((m) => {
            const selected = m === value;
            return (
              <button
                key={m}
                type="button"
                role="radio"
                aria-checked={selected}
                onClick={() => {
                  onChange(m);
                  close();
                }}
                data-testid={`tray-model-option-${m}`}
                className={cn(
                  'flex items-center justify-between gap-3 px-3 py-1.5 text-left text-xs',
                  'transition-colors duration-fast ease-out-expo',
                  'hover:bg-surface-elevated focus-visible:outline-none focus-visible:bg-surface-elevated',
                  selected ? 'text-accent' : 'text-foreground/85'
                )}
              >
                <span className="flex items-center gap-2">
                  <Cpu strokeWidth={1.5} className="h-3.5 w-3.5 opacity-70" />
                  <span className="font-medium">{m}</span>
                </span>
                {selected ? <Check strokeWidth={2} className="h-3.5 w-3.5 text-accent" /> : null}
              </button>
            );
          })}
        </div>
      )}
    </PickerPopover>
  );
}

function abbreviateModel(m: string): string {
  // gpt-5.5-codex -> Codex 5.5
  // gpt-5-codex   -> Codex 5
  // o4-mini       -> o4-mini
  if (m.includes('codex')) {
    const ver = m.match(/gpt-([\d.]+)/)?.[1];
    return ver ? `Codex ${ver}` : 'Codex';
  }
  return m;
}

// ---------------------------------------------------------------------------
// Effort Picker
// ---------------------------------------------------------------------------

interface EffortPickerProps {
  value: ReasoningEffort;
  onChange: (v: ReasoningEffort) => void;
  ariaLabel: string;
  triggerLabel: string;
  options: Record<ReasoningEffort, { label: string; desc: string }>;
}

function EffortPicker({ value, onChange, ariaLabel, triggerLabel, options }: EffortPickerProps) {
  const abbreviate = (e: ReasoningEffort): string => {
    if (e === 'low') return 'low';
    if (e === 'medium') return 'med';
    return 'high';
  };

  return (
    <PickerPopover
      ariaLabel={ariaLabel}
      testId="tray-effort-picker"
      trigger={
        <span className="flex items-center gap-1.5">
          <Gauge strokeWidth={1.5} className="h-3.5 w-3.5 text-accent" />
          <span className="hidden md:inline text-muted-foreground">{triggerLabel}:</span>
          <span className="text-foreground/85 font-medium">{abbreviate(value)}</span>
          <ChevronDown strokeWidth={1.5} className="h-3 w-3 opacity-60" />
        </span>
      }
    >
      {(close) => (
        <div role="radiogroup" aria-label={ariaLabel} className="flex flex-col py-1 min-w-[200px]">
          {EFFORTS.map((e) => {
            const selected = e === value;
            const opt = options[e];
            return (
              <button
                key={e}
                type="button"
                role="radio"
                aria-checked={selected}
                onClick={() => {
                  onChange(e);
                  close();
                }}
                data-testid={`tray-effort-option-${e}`}
                className={cn(
                  'flex items-start justify-between gap-3 px-3 py-1.5 text-left',
                  'transition-colors duration-fast ease-out-expo',
                  'hover:bg-surface-elevated focus-visible:outline-none focus-visible:bg-surface-elevated',
                  selected ? 'text-accent' : 'text-foreground/85'
                )}
              >
                <span className="flex flex-col">
                  <span className={cn('text-xs font-medium', selected && 'text-accent')}>
                    {opt.label}
                  </span>
                  <span className="text-[10px] text-muted-foreground/80">{opt.desc}</span>
                </span>
                {selected ? <Check strokeWidth={2} className="mt-0.5 h-3.5 w-3.5 text-accent" /> : null}
              </button>
            );
          })}
        </div>
      )}
    </PickerPopover>
  );
}

// ---------------------------------------------------------------------------
// Picker Popover (lightweight inline primitive)
// ---------------------------------------------------------------------------
//
// shadcn/ui Popover が repo に存在しないため、AS-UX-01 範囲では最小限の
// inline 実装を提供する。将来 AS-UX 系で複数箇所から再利用が必要になった
// 時点で `src/components/ui/popover.tsx` に切り出す（YAGNI）。

interface PickerPopoverProps {
  ariaLabel: string;
  testId: string;
  trigger: ReactNode;
  children: (close: () => void) => ReactNode;
}

function PickerPopover({ ariaLabel, testId, trigger, children }: PickerPopoverProps) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);

  // 外側クリックで閉じる + Esc で閉じる
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      const node = containerRef.current;
      if (node && e.target instanceof Node && !node.contains(e.target)) {
        setOpen(false);
      }
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    window.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  const close = () => {
    setOpen(false);
    triggerRef.current?.focus();
  };

  return (
    <div ref={containerRef} className="relative" data-testid={testId}>
      <button
        ref={triggerRef}
        type="button"
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        data-state={open ? 'open' : 'closed'}
        onClick={() => setOpen((v) => !v)}
        className={cn(
          'flex h-6 items-center gap-1.5 rounded-sm px-2',
          'transition-colors duration-fast ease-out-expo',
          'hover:bg-surface-elevated focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
          open && 'bg-surface-elevated'
        )}
      >
        {trigger}
      </button>
      <AnimatePresence>
        {open ? (
          <motion.div
            role="dialog"
            aria-label={ariaLabel}
            initial={{ opacity: 0, y: -4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
            transition={{ duration: 0.15, ease: [0.16, 1, 0.3, 1] }}
            className={cn(
              'absolute left-0 top-full z-50 mt-1 min-w-[160px]',
              'rounded-md border border-border bg-popover text-popover-foreground shadow-md'
            )}
          >
            {children(close)}
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}
