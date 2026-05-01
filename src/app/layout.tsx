import type { Metadata } from 'next';
import { GeistSans } from 'geist/font/sans';
import { GeistMono } from 'geist/font/mono';
import { ThemeProvider } from 'next-themes';
import { Toaster } from 'sonner';
import { ClientIntlProvider } from '@/components/providers/intl-provider';
import './globals.css';

export const metadata: Metadata = {
  title: 'Asagi',
  description: 'Codex マルチプロジェクト IDE',
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
      </body>
    </html>
  );
}
