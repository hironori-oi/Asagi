import type { Metadata, Viewport } from 'next';
import { GeistSans } from 'geist/font/sans';
import { GeistMono } from 'geist/font/mono';
import { ThemeProvider } from 'next-themes';
import { Toaster } from 'sonner';
import { ClientIntlProvider } from '@/components/providers/intl-provider';
import { ErrorBoundary } from '@/components/error-boundary';
import './globals.css';

export const metadata: Metadata = {
  title: 'Asagi',
  description: 'Codex 版 IDE — 浅葱（あさぎ）。日本語ファースト、Slack 風 Multi-Project、ローカル永続化。',
  applicationName: 'Asagi',
  icons: {
    icon: [
      { url: '/favicon.svg', type: 'image/svg+xml' },
      { url: '/favicon.ico', sizes: 'any' },
      { url: '/favicon-16x16.png', type: 'image/png', sizes: '16x16' },
      { url: '/favicon-32x32.png', type: 'image/png', sizes: '32x32' },
    ],
    apple: [
      { url: '/apple-touch-icon.png', sizes: '180x180', type: 'image/png' },
    ],
  },
};

// DEC-018-020 (γ 浅葱滴) brand accent — dark/light で分離指定
export const viewport: Viewport = {
  themeColor: [
    { media: '(prefers-color-scheme: dark)', color: '#0a0e14' },
    { media: '(prefers-color-scheme: light)', color: '#5BB8C4' },
  ],
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html
      lang="ja"
      suppressHydrationWarning
      className={`${GeistSans.variable} ${GeistMono.variable}`}
    >
      <body className="h-full bg-background text-foreground antialiased">
        <ErrorBoundary>
          <ClientIntlProvider>
            <ThemeProvider
              attribute="data-theme"
              defaultTheme="dark"
              enableSystem
              disableTransitionOnChange
              themes={['light', 'dark', 'system']}
            >
              {children}
              <Toaster
                position="bottom-right"
                theme="dark"
                richColors
                closeButton
                toastOptions={{
                  classNames: {
                    toast: 'bg-surface border border-border text-foreground',
                    description: 'text-muted-foreground',
                    actionButton: 'bg-accent text-accent-foreground',
                    cancelButton: 'bg-surface-elevated text-foreground',
                  },
                }}
              />
            </ThemeProvider>
          </ClientIntlProvider>
        </ErrorBoundary>
      </body>
    </html>
  );
}
