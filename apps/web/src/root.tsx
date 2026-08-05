import { useSyncExternalStore } from 'react';
import {
  isRouteErrorResponse,
  Links,
  Outlet,
  Scripts,
} from 'react-router';
import criticalCss from 'virtual:floway-critical.css?inline';
import winuiStylesheet from 'virtual:floway-winui.css?url';

import type { Route } from './+types/root';
import { BrowserLanguageSync } from './components/browser-language-sync';
import { DocumentTitleSync } from './components/document-title-sync';
import { GradientBackground } from './components/gradient-background';
import { markPickerScript } from './components/logo-mark';
import { NavigationProgress } from './components/navigation-progress';
import { ErrorShell, ErrorStack } from './components/ui/error-shell';
import { AppLoadingScreen } from './components/ui/loading-screen';
import { fluentComponents } from './fluent';
import { defaultLanguage, htmlLanguageFor } from './i18n/languages';
import { useTranslation } from './i18n/translation';
import { useSourceMappedStack } from './lib/source-mapped-stack';
import { DARK_SCHEME_QUERY, useMediaQuery } from './lib/use-media-query';
import { winuiDarkTheme, winuiLightTheme } from './winui/theme';
import './i18n';
import '@fontsource/maple-mono/400.css';
import '@fontsource/maple-mono/600.css';
import '@fontsource/maple-mono/700.css';
import './global.css';

const { Button, FluentProvider, Spinner } = fluentComponents;

// Fonts are fetched in CORS mode whatever the crossOrigin value, and a preload
// whose mode disagrees with the real request is fetched twice.
// https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Attributes/rel/preload#cors-enabled_fetches
// The version query isolates the cross-origin response from a bare-path Azure
// CDN cache entry stored with docs.azure.cn as its sole allowed origin and no
// `Vary: Origin`.
// Only the mirror is warmed. ./global.css names learn.microsoft.com behind it as
// a second source, and preloading that too would spend a second megabyte on
// every visit to save a fraction of the visits where the mirror is unreachable.
const SEGOE_UI_VARIABLE_MIRROR_URL = 'https://docs.azure.cn/static/third-party/SegoeUIVariable/SegoeUI-VF.ttf?floway-vf=2.02';

export const links: Route.LinksFunction = () => [
  { rel: 'preconnect', href: 'https://docs.azure.cn', crossOrigin: 'anonymous' },
  { rel: 'preload', as: 'font', type: 'font/ttf', href: SEGOE_UI_VARIABLE_MIRROR_URL, crossOrigin: 'anonymous' },
];

const useSystemTheme = () => useMediaQuery(DARK_SCHEME_QUERY) ? winuiDarkTheme : winuiLightTheme;

export function Layout({ children }: { children: React.ReactNode }) {
  const theme = useSystemTheme();

  return (
    <html lang={htmlLanguageFor(defaultLanguage)}>
      <head>
        <meta charSet="utf-8" />
        <meta name="darkreader-lock" content="true" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        {/* A deployed instance is one operator's console, not a public site. */}
        <meta name="robots" content="noindex" />
        <meta name="theme-color" content="#f5f5f5" media="(prefers-color-scheme: light)" />
        <meta name="theme-color" content="#111111" media="(prefers-color-scheme: dark)" />
        <title>Floway</title>
        <Links />
        {/* Inlined because it has to be true before a linked stylesheet can
            arrive. See ./critical.css.ts. */}
        <style>{criticalCss}</style>
        {/* Linked by hand rather than through `<Links />`, which renders ahead
            of anything this component writes: the WinUI layer has to follow the
            block above, whose spinner rules reach Fluent's class names at the
            same specificity. */}
        <link href={winuiStylesheet} rel="stylesheet" />
        {/* Inline so the mark and tab icon are set before anything paints. */}
        <script dangerouslySetInnerHTML={{ __html: markPickerScript }} />
      </head>
      <body className="text-[14px]">
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

// The prerendered HTML carries HydrateFallback's boot screen, so rendering the
// error tree during hydration itself is a mismatch React recovers from by
// rebuilding the page. Hydrating the fallback and showing the failure on the
// next pass keeps that exchange one React handles.
const subscribeNever = () => () => {};
const isClient = () => true;
const isServer = () => false;
export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  const { t } = useTranslation();
  const hydrated = useSyncExternalStore(subscribeNever, isClient, isServer);
  let message = t('common.errors.unexpectedTitle');
  let details = t('common.errors.unexpectedDescription');
  let rawStack: string | undefined;

  if (isRouteErrorResponse(error)) {
    message = error.status === 404 ? '404' : t('common.errors.title');
    details =
      error.status === 404
        ? t('common.errors.notFound')
        : error.statusText || details;
  } else if (error instanceof Error) {
    details = error.message;
    rawStack = error.stack;
  }

  const restoration = useSourceMappedStack(rawStack);

  if (!hydrated) return <AppLoadingScreen label={t('common.loading')} />;

  const stack = restoration.stack;
  // While the trace is the minified one, the sentence the trace replaced is
  // given over to saying so. The row is declared on a span of our own: Fluent's
  // Text carries a `display` atom of the same weight, and Griffel injects at
  // runtime, so a rule on the Text itself always loses the tie.
  const note = restoration.status === 'loading'
    ? (
        <span className="inline-flex items-center gap-2 align-middle">
          {/* The message slot is a paragraph, which may hold no `div`. */}
          <Spinner as="span" size="tiny" />
          {t('common.errors.sourceMapLoading')}
        </span>
      )
    : restoration.status === 'failed'
      ? t('common.errors.sourceMapFailed')
      : undefined;

  return (
    <ErrorShell
      action={
        <>
          {/* A reload, not a router navigation: whatever failed may have left
              app state or modules in a shape a navigation would keep. */}
          <Button appearance="primary" onClick={() => window.location.reload()}>
            {t('common.errors.refresh')}
          </Button>
          <Button onClick={() => window.history.back()}>{t('common.errors.back')}</Button>
        </>
      }
      message={stack ? note : details}
      title={message}
    >
      {stack && <ErrorStack>{stack}</ErrorStack>}
    </ErrorShell>
  );
}
