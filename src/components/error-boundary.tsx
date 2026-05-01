'use client';

import { Component, type ErrorInfo, type ReactNode } from 'react';
import { AlertTriangle, RotateCw, FileText } from 'lucide-react';
import { logger } from '@/lib/logger';

interface ErrorBoundaryProps {
  children: ReactNode;
  fallback?: (props: { error: Error; reset: () => void }) => ReactNode;
}

interface ErrorBoundaryState {
  error: Error | null;
}

/**
 * React Error Boundary (AS-META-07)。
 *
 * 致命的エラーを catch し、Reload ボタン + ログを開くボタン付きの
 * フォールバック UI を表示。
 *
 * - 開発時: コンソールにスタック出力
 * - production: tauri ログファイル (~/.asagi/logs/) に書込み (logger 経由)
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    logger.error('ErrorBoundary caught', {
      message: error.message,
      stack: error.stack,
      componentStack: info.componentStack,
    });
  }

  reset = () => {
    this.setState({ error: null });
  };

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    if (this.props.fallback) {
      return this.props.fallback({ error, reset: this.reset });
    }

    return <DefaultErrorFallback error={error} reset={this.reset} />;
  }
}

interface FallbackProps {
  error: Error;
  reset: () => void;
}

function DefaultErrorFallback({ error, reset }: FallbackProps) {
  const handleOpenLogs = () => {
    // Tauri 接続環境ならファイルを開く。失敗時は console に case を残す。
    void (async () => {
      try {
        // 動的 import で Tauri 非接続でも fallback 可。
        const shell = await import('@tauri-apps/plugin-shell').catch(() => null);
        if (!shell) return;
        // logger.ts と同じパス規約。Win: %USERPROFILE%, *nix: $HOME。
        // 開くのは「ログディレクトリ」だけにし、最新ファイル選択は OS に任せる。
        const home =
          (typeof navigator !== 'undefined' && navigator.userAgent.includes('Win'))
            ? '%USERPROFILE%\\.asagi\\logs'
            : '$HOME/.asagi/logs';
        await shell.open(home);
      } catch (err) {
        logger.warn('Failed to open logs dir', { err: String(err) });
      }
    })();
  };

  return (
    <div
      role="alert"
      aria-live="assertive"
      className="flex min-h-screen flex-col items-center justify-center gap-6 bg-background px-6 py-12 text-foreground"
    >
      <div className="flex h-16 w-16 items-center justify-center rounded-full bg-destructive/10 text-destructive">
        <AlertTriangle strokeWidth={1.5} className="h-8 w-8" />
      </div>
      <div className="max-w-md text-center">
        <h1 className="text-xl font-semibold">申し訳ございません、エラーが発生しました</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          画面の再読み込みで多くの問題は解消します。再現する場合はログを添えて報告してください。
        </p>
      </div>
      <pre
        className="max-h-40 w-full max-w-2xl overflow-auto rounded-md border border-border bg-surface-elevated p-3 text-left font-mono text-xs text-muted-foreground"
        aria-label="エラー詳細"
      >
        {error.message}
        {'\n\n'}
        {error.stack?.split('\n').slice(0, 6).join('\n')}
      </pre>
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={reset}
          className="inline-flex items-center gap-1.5 rounded-md bg-accent px-4 py-2 text-sm font-medium text-accent-foreground transition-colors hover:bg-accent/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <RotateCw strokeWidth={1.5} className="h-4 w-4" />
          画面を再読み込み
        </button>
        <button
          type="button"
          onClick={handleOpenLogs}
          className="inline-flex items-center gap-1.5 rounded-md border border-border bg-surface px-4 py-2 text-sm text-foreground transition-colors hover:bg-surface-elevated focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <FileText strokeWidth={1.5} className="h-4 w-4" />
          ログを開く
        </button>
      </div>
    </div>
  );
}
