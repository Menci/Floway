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
import { fontFamilyCriticalCss } from './theme';
import { winuiCss } from './winui';
import { winuiDarkTheme, winuiLightTheme } from './winui/theme';
import './i18n';
import '@fontsource/maple-mono/400.css';
import '@fontsource/maple-mono/600.css';
import '@fontsource/maple-mono/700.css';
import './segoe-ui-variable.css';
import './uno.css';

const { Button, FluentProvider } = fluentComponents;

// The base typeface is the one third-party fetch the first paint waits on, so
// it is preloaded rather than discovered when the stylesheet resolves. Fonts
// are fetched in CORS mode whatever the crossOrigin value, and a preload whose
// mode disagrees with the real request is fetched twice.
// https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Attributes/rel/preload#cors-enabled_fetches
// The version query also isolates the cross-origin response from a bare-path
// Azure CDN cache entry that was stored with docs.azure.cn as its sole allowed
// origin and no `Vary: Origin` header.
const SEGOE_UI_VARIABLE_URL = 'https://docs.azure.cn/static/third-party/SegoeUIVariable/SegoeUI-VF.ttf?floway-vf=2.02';

export const links: Route.LinksFunction = () => [
  { rel: 'preconnect', href: 'https://docs.azure.cn', crossOrigin: 'anonymous' },
  { rel: 'preload', as: 'font', type: 'font/ttf', href: SEGOE_UI_VARIABLE_URL, crossOrigin: 'anonymous' },
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
          @media (prefers-color-scheme: dark) { html { color-scheme: dark; } }
          *, *::before, *::after { box-sizing: border-box; }
          html body pre[class*="language-"] { border: 0; }
          ${fontFamilyCriticalCss}
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
  } else if (error instanceof Error) {
    details = error.message;
    stack = error.stack;
  }

  return (
    <ErrorShell
      action={
        <div className="flex flex-wrap justify-center gap-2">
          {/* A reload, not a re-render: whatever failed may have left the app's
              own state or its modules in a shape a router navigation would
              keep, and the browser's own back is the one exit that does not
              depend on this page working. */}
          <Button appearance="primary" onClick={() => window.location.reload()}>
            {t('common.errors.refresh')}
          </Button>
          <Button onClick={() => window.history.back()}>{t('common.errors.back')}</Button>
        </div>
      }
      message={stack ? undefined : details}
      title={message}
    >
      {stack && <ErrorStack>{stack}</ErrorStack>}
    </ErrorShell>
  );
}
