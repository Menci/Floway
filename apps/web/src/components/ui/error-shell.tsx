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
export function ErrorShell({ action, children, message, title }: PropsWithChildren<{
  action?: ReactNode;
  message: string;
  title: string;
}>) {
  return (
    <ScrollArea axes="vertical" className="h-[100dvh]" contentClassName="h-full">
      {/* Filling the scroller rather than the window. Its viewport is shorter
          than the window whenever a scrollbar takes width, so a child measured
          against the window is permanently taller than its container and the
          bar can never retract. `min-h-max` keeps a long trace scrolling. */}
      <main className="mx-auto grid h-full min-h-max max-w-[720px] content-center justify-items-center gap-6 px-6 py-16 text-center">
        <div className="grid justify-items-center gap-4">
          <div className="grid gap-1.5">
            <Text as="h1" className="m-0" size={700} weight="semibold">{title}</Text>
            <Text as="p" className="m-0 text-fui-fg2" size={300}>{message}</Text>
          </div>
          {action}
        </div>
        {children}
      </main>
    </ScrollArea>
  );
}

// The trace, when there is one. It sits on its own surface so it reads as
// evidence attached to the message rather than as more of the message, and it
// scrolls on its own so a long line cannot widen the page under it. Its text is
// left-aligned against the centred page above: a trace is read from its first
// character, not from its middle.
export function ErrorStack({ children, label }: PropsWithChildren<{ label: string }>) {
  return (
    <section className="grid w-full min-w-0 gap-2 text-left">
      <Text as="h2" className="m-0 text-fui-fg2" size={200} weight="semibold">{label}</Text>
      <ScrollArea
        axes="horizontal"
        className="min-w-0 rounded-[var(--winui-overlay-corner-radius,8px)] border border-solid border-fui-stroke1 bg-fui-bg2"
      >
        <pre className="m-0 w-max min-w-full p-4 font-mono"><code>{children}</code></pre>
      </ScrollArea>
    </section>
  );
}
