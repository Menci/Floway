import {
  isRouteErrorResponse,
  Links,
  Meta,
  Outlet,
  Scripts,
  ScrollRestoration,
} from "react-router";
import { useEffect, useState } from "react";

import type { Route } from "./+types/root";
import { BrowserLanguageSync } from "./components/browser-language-sync";
import { DocumentTitleSync } from "./components/document-title-sync";
import { ErrorShell, ErrorStack } from "./components/ui/error-shell";
import { GradientBackground } from "./components/gradient-background";
import { fluentComponents } from "./fluent";
import { flowayDarkTheme, flowayLightTheme } from "./theme";
import "./i18n";
import "virtual:uno.css";

const { FluentProvider } = fluentComponents;

export const links: Route.LinksFunction = () => [];

function useSystemTheme() {
  const [dark, setDark] = useState(
    () =>
      typeof window !== "undefined" &&
      window.matchMedia("(prefers-color-scheme: dark)").matches,
  );
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = (e: MediaQueryListEvent) => setDark(e.matches);
    mq.addEventListener("change", onChange);
    setReady(true);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  const theme = dark ? flowayDarkTheme : flowayLightTheme;
  return { theme, ready };
}

export function Layout({ children }: { children: React.ReactNode }) {
  const { theme, ready } = useSystemTheme();

  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="darkreader-lock" content="true" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <Meta />
        <Links />
        <style>{`
          html, body { min-height: 100%; }
          @media (prefers-color-scheme: dark) { html { color-scheme: dark; } }
          *, *::before, *::after { box-sizing: border-box; }
          html body pre[class*="language-"] { border: 0; }
        `}</style>
      </head>
      <body className="text-[14px] font-sans m-0">
        <FluentProvider key={ready ? "ready" : "init"} theme={theme}>
          <BrowserLanguageSync />
          <GradientBackground>{children}</GradientBackground>
        </FluentProvider>
        <ScrollRestoration />
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

export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  let message = "Oops!";
  let details = "An unexpected error occurred.";
  let stack: string | undefined;

  if (isRouteErrorResponse(error)) {
    message = error.status === 404 ? "404" : "Error";
    details =
      error.status === 404
        ? "The requested page could not be found."
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
