import { useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import {
  isRouteErrorResponse,
  Links,
  Meta,
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
import { AppLoadingScreen } from './components/ui/app-loading-screen';
import { ErrorShell, ErrorStack } from './components/ui/error-shell';
import { fluentComponents } from './fluent';
import { winuiDarkTheme, winuiLightTheme } from './winui/theme';
import './i18n';
import '@fontsource/maple-mono/400.css';
import '@fontsource/maple-mono/600.css';
import '@fontsource/maple-mono/700.css';
import './global.css';

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
        {/* Everything the first paint depends on, inlined because it has to be
            true before a linked stylesheet can arrive. Its rules and the
            reasons they are here are in ./critical.css.ts. */}
        <style>{criticalCss}</style>
        {/* The WinUI layer is linked rather than emitted through `<Links />`
            because where it sits is what it is: it has to follow the block
            above, whose spinner rules reach Fluent's own class names at the
            same specificity its do. `<Links />` renders the route's stylesheets
            ahead of anything this component writes, so the link is placed by
            hand. */}
        <link href={winuiStylesheet} rel="stylesheet" />
        {/* Draws this load's mark and sets the tab icon before anything paints. */}
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

// The prerendered index.html carries HydrateFallback's boot screen, because
// every path in the SPA starts from that one file. A route that resolves
// normally swaps the fallback for its content through the router, and React is
// party to the exchange. An error boundary is not: it renders in place of the
// tree during hydration itself, so React finds a page where it expected a
// spinner, refuses the tree it was given and rebuilds it from scratch -- a
// hydration mismatch, and for the frames it lasts the page is half styled.
//
// Hydrating the fallback first and showing the failure on the pass after keeps
// the exchange the one React already handles. Read through
// useSyncExternalStore rather than an effect that sets state: the store never
// changes, so the hook is doing the one thing it exists for -- returning a
// different value on the server pass than on the client -- without a render
// that exists only to schedule another.
const subscribeNever = () => () => {};
const isClient = () => true;
const isServer = () => false;
export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  const { t } = useTranslation();
  const hydrated = useSyncExternalStore(subscribeNever, isClient, isServer);
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

  if (!hydrated) return <AppLoadingScreen label={t('common.loading')} />;

  return (
    <ErrorShell
      action={
        <div className="floway-error-shell-actions">
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
