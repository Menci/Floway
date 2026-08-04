import type { PropsWithChildren, ReactNode } from 'react';

import { ScrollArea } from './scroll-area';
import { fluentComponents } from '../../fluent';

const { Text } = fluentComponents;

export function ErrorShell({ action, children, message, title }: PropsWithChildren<{
  action?: ReactNode;
  /**
   * Omitted when a trace is shown and it needs nothing said about it: the
   * trace's first line is this sentence.
   */
  message?: ReactNode;
  title: string;
}>) {
  return (
    <ScrollArea axes="vertical" className="floway-error-shell-viewport" contentClassName="h-full">
      {/* Fills the scroller, not the window: the viewport is shorter than the
          window whenever a scrollbar takes width, so a window-measured child
          never lets the bar retract. */}
      <main className="floway-error-shell">
        <div className="floway-error-shell-stack">
          {/* `align` rather than a rule of our own: Fluent's Text emits a
              text-align atom regardless, and Griffel injects at runtime, so an
              equal-weight rule here always loses the tie. */}
          <Text align="center" as="h1" size={700} weight="semibold">{title}</Text>
          {message !== undefined && <Text align="center" as="p" className="text-fui-fg2" size={300}>{message}</Text>}
        </div>
        {children}
        {action !== undefined && <div className="floway-error-shell-actions">{action}</div>}
      </main>
    </ScrollArea>
  );
}

export function ErrorStack({ children }: PropsWithChildren) {
  return (
    <ScrollArea
      axes="horizontal"
      className="winui-focus-rect-within w-full min-w-0 rounded-[var(--winui-overlay-corner-radius,8px)] border border-solid border-fui-stroke1 bg-fui-bg2 text-left"
    >
      <pre className="m-0 w-max min-w-full p-4 font-mono"><code>{children}</code></pre>
    </ScrollArea>
  );
}
