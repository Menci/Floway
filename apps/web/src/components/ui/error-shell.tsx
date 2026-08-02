import type { PropsWithChildren, ReactNode } from 'react';

import { ScrollArea } from './scroll-area';
import { fluentComponents } from '../../fluent';

const { Text, makeStyles, mergeClasses } = fluentComponents;

const useStyles = makeStyles({
  // The scrolled region is a tab stop wherever the platform's scrollbars take
  // layout width, because that is where the scrollbar library takes the
  // viewport over and gives it a tabindex. The frame below is drawn on the
  // host, whose padding box is the viewport's border box exactly, so a ring
  // outside the viewport is cut on all four sides and there is no room to open
  // a gutter in -- a gutter would float the trace off the frame it is set in.
  // It is drawn inward instead, the same rule ./code-block.tsx states for the
  // same situation: a 2px FocusStrokeColorOuter outline over the outer two of
  // an inner ring's three pixels.
  // https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L54-L55
  // https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L258-L259
  stack: {
    '& :focus-visible': {
      boxShadow: 'inset 0 0 0 3px var(--winui-focus-stroke-inner)',
      outline: '2px solid var(--winui-focus-stroke-outer)',
      outlineOffset: '-2px',
    },
  },
});

// The app's error surface: the one page that renders without the dashboard
// around it. It states the type itself rather than taking classes from the
// boundary, so the heading and the line under it land on the same ramp a page
// header uses instead of falling to the user agent's `2em` bold.
//
// The page centres whether or not it carries a trace. A failure is a single
// statement wherever it appears, and a trace that pushes past the fold is
// reached by scrolling rather than by moving the statement off centre.
//
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
          bar can never retract. The shell's own `min-height: max-content` is
          what keeps a long trace scrolling. */}
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
            the page is making. The row's own layout is the shell's, so the
            caller hands over commands rather than a laid-out band. */}
        {action !== undefined && <div className="floway-error-shell-actions">{action}</div>}
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
  const styles = useStyles();
  return (
    <ScrollArea
      axes="horizontal"
      className={mergeClasses('w-full min-w-0 rounded-[var(--winui-overlay-corner-radius,8px)] border border-solid border-fui-stroke1 bg-fui-bg2 text-left', styles.stack)}
    >
      <pre className="m-0 w-max min-w-full p-4 font-mono"><code>{children}</code></pre>
    </ScrollArea>
  );
}
