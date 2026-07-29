import { useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import {
  isRouteErrorResponse,
  Links,
  Meta,
  Outlet,
  Scripts,
} from 'react-router';

import type { Route } from './+types/root';
import { BrowserLanguageSync } from './components/browser-language-sync';
import { DocumentTitleSync } from './components/document-title-sync';
import {
  GradientBackground,
  gradientBackgroundCriticalCss,
} from './components/gradient-background';
import { NavigationProgress, navigationProgressCss } from './components/navigation-progress';
import {
  AppLoadingScreen,
  appLoadingCriticalCss,
} from './components/ui/app-loading-screen';
import { ErrorShell, ErrorStack } from './components/ui/error-shell';
import { fluentComponents } from './fluent';
import { baseFontStack } from './theme';
import { segoeWebFontCss, segoeWebFontOrigin, segoeWebFonts } from './web-fonts';
import { winuiCss } from './winui';
import { winuiDarkTheme, winuiLightTheme } from './winui/theme';
import './i18n';
import '@fontsource/maple-mono/400.css';
import '@fontsource/maple-mono/600.css';
import '@fontsource/maple-mono/700.css';
import './uno.css';

const { FluentProvider } = fluentComponents;

export const links: Route.LinksFunction = () => [
  { rel: 'preconnect', href: segoeWebFontOrigin, crossOrigin: 'anonymous' },
  { rel: 'preload', href: segoeWebFonts.regular, as: 'font', type: 'font/woff2', crossOrigin: 'anonymous' },
  { rel: 'preload', href: segoeWebFonts.semibold, as: 'font', type: 'font/woff2', crossOrigin: 'anonymous' },
];

const COLOR_SCHEME_QUERY = '(prefers-color-scheme: dark)';

const subscribeToColorScheme = (onChange: () => void): (() => void) => {
  const query = window.matchMedia(COLOR_SCHEME_QUERY);
  query.addEventListener('change', onChange);
  return () => query.removeEventListener('change', onChange);
};

// The build-time prerender has no matchMedia, so the server snapshot reports
// light and the client corrects on hydration. useSyncExternalStore is what
// makes that a subscription rather than state mirrored through an effect.
const useSystemTheme = () => {
  const dark = useSyncExternalStore(
    subscribeToColorScheme,
    () => window.matchMedia(COLOR_SCHEME_QUERY).matches,
    () => false,
  );
  return dark ? winuiDarkTheme : winuiLightTheme;
};

export function Layout({ children }: { children: React.ReactNode }) {
  const theme = useSystemTheme();

  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="darkreader-lock" content="true" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="theme-color" content="#f5f5f5" media="(prefers-color-scheme: light)" />
        <meta name="theme-color" content="#111111" media="(prefers-color-scheme: dark)" />
        <Meta />
        <Links />
        <style>{`
          html, body { height: 100%; overflow: hidden; }
          body { font-family: ${baseFontStack}; }
          @media (prefers-color-scheme: dark) { html { color-scheme: dark; } }
          *, *::before, *::after { box-sizing: border-box; }
          html body pre[class*="language-"] { border: 0; }
          ${segoeWebFontCss}
          ${gradientBackgroundCriticalCss}
          ${appLoadingCriticalCss}
          ${navigationProgressCss}
        `}</style>
        <style>{winuiCss}</style>
      </head>
      <body className="text-[14px] m-0">
        <FluentProvider theme={theme}>
          <BrowserLanguageSync />
          <GradientBackground>{children}</GradientBackground>
        </FluentProvider>
        <Scripts />
      </body>
    </html>
  );
}

export default function App() {
  return (
    <>
      <NavigationProgress />
      <DocumentTitleSync />
      <Outlet />
    </>
  );
}

export function HydrateFallback() {
  const { t } = useTranslation();
  return <AppLoadingScreen label={t('common.loading')} />;
}

export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  const { t } = useTranslation();
  let message = t('common.errors.unexpectedTitle');
  let details = t('common.errors.unexpectedDescription');
  let stack: string | undefined;

  if (isRouteErrorResponse(error)) {
    message = error.status === 404 ? '404' : t('common.errors.title');
    details =
      error.status === 404
        ? t('common.errors.notFound')
        : error.statusText || details;
  } else if (import.meta.env.DEV && error && error instanceof Error) {
    details = error.message;
    stack = error.stack;
  }

  return (
    <ErrorShell>
      <h1>{message}</h1>
      <p>{details}</p>
      {stack && <ErrorStack>{stack}</ErrorStack>}
    </ErrorShell>
  );
}
