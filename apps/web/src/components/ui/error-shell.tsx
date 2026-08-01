import type { PropsWithChildren, ReactNode } from 'react';

import { ScrollArea } from './scroll-area';
import { fluentComponents } from '../../fluent';

const { Text } = fluentComponents;

// The app's error surface: the one page that renders without the dashboard
// around it. It states the type itself rather than taking classes from the
// boundary, so the heading and the line under it land on the same ramp a page
// header uses instead of falling to the user agent's `2em` bold.
//
// The page centres whether or not it carries a trace. A failure is a single
// statement wherever it appears, and a trace that pushes past the fold is
// reached by scrolling rather than by moving the statement off centre.
//
// Its layout is stated here rather than in utility classes, and it is the third
// surface to need that -- the boot screen and the gradient behind it are the
// others. All three are shown before the stylesheet has arrived: in dev that is
// well over a second, and an error page is the one screen most likely to be
// reached in exactly that window, since a failure is often what made the load
// slow. Left to utilities it renders unstyled -- the heading left-aligned over
// centred buttons, which is what the boot screen's own critical CSS exists to
// avoid for itself.
export const errorShellCriticalCss = `
  .floway-error-shell {
    box-sizing: border-box;
    display: grid;
    align-content: center;
    justify-items: center;
    gap: 24px;
    height: 100%;
    min-height: max-content;
    margin: 0 auto;
    max-width: 720px;
    padding: 64px 24px;
    text-align: center;
  }
  .floway-error-shell > * { min-width: 0; max-width: 100%; }
  .floway-error-shell-viewport { height: 100dvh; }
  .floway-error-shell-stack { display: grid; gap: 6px; }
  .floway-error-shell-stack > * { margin: 0; }
  .floway-error-shell-actions { display: flex; flex-wrap: wrap; justify-content: center; gap: 8px; }
`;
export function ErrorShell({ action, children, message, title }: PropsWithChildren<{
  action?: ReactNode;
  /** Omitted when a trace is shown: the trace's first line is this sentence. */
  message?: string;
  title: string;
}>) {
  return (
    <ScrollArea axes="vertical" className="floway-error-shell-viewport" contentClassName="h-full">
      {/* Filling the scroller rather than the window. Its viewport is shorter
          than the window whenever a scrollbar takes width, so a child measured
          against the window is permanently taller than its container and the
          bar can never retract. `min-h-max` keeps a long trace scrolling. */}
      <main className="floway-error-shell">
        <div className="floway-error-shell-stack">
          {/* `align` rather than a rule of our own: Fluent's Text emits a
              text-align atom whatever the page around it says, and Griffel
              injects at runtime, so an equal-weight rule here always loses the
              tie. Asking the component stops the atom being emitted. */}
          <Text align="center" as="h1" size={700} weight="semibold">{title}</Text>
          {message !== undefined && <Text align="center" as="p" className="text-fui-fg2" size={300}>{message}</Text>}
        </div>
        {children}
        {/* After the trace, not before it: the trace is what the operator is
            here to read, and an action placed above it interrupts the sentence
            the page is making. */}
        {action}
      </main>
    </ScrollArea>
  );
}

// The trace, when there is one. It sits on its own surface so it reads as
// evidence attached to the message rather than as more of the message, and it
// scrolls on its own so a long line cannot widen the page under it. Its text is
// left-aligned against the centred page above: a trace is read from its first
// character, not from its middle. It carries no heading -- its first line names
// the error, which is the only label it could be given.
export function ErrorStack({ children }: PropsWithChildren) {
  return (
    <ScrollArea
      axes="horizontal"
      className="w-full min-w-0 rounded-[var(--winui-overlay-corner-radius,8px)] border border-solid border-fui-stroke1 bg-fui-bg2 text-left"
    >
      <pre className="m-0 w-max min-w-full p-4 font-mono"><code>{children}</code></pre>
    </ScrollArea>
  );
}
