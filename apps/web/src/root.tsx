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
import {
  AppLoadingScreen,
  appLoadingCriticalCss,
} from './components/ui/app-loading-screen';
import { ErrorShell, ErrorStack } from './components/ui/error-shell';
import { scrollAreaCss } from './components/ui/scroll-area';
import { fluentComponents } from './fluent';
import { flowayDarkTheme, flowayLightTheme } from './theme';
import './i18n';
import 'virtual:uno.css';

const { FluentProvider } = fluentComponents;

export const links: Route.LinksFunction = () => [];

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
  return dark ? flowayDarkTheme : flowayLightTheme;
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
          @media (prefers-color-scheme: dark) { html { color-scheme: dark; } }
          *, *::before, *::after { box-sizing: border-box; }
          html body pre[class*="language-"] { border: 0; }
          ${gradientBackgroundCriticalCss}
          ${appLoadingCriticalCss}
          ${scrollAreaCss}
        `}</style>
      </head>
      <body className="text-[14px] font-sans m-0">
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
