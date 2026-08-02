import type { PropsWithChildren, ReactNode } from 'react';

import { ScrollArea } from './scroll-area';
import { fluentComponents } from '../../fluent';

const { Text, makeStyles, mergeClasses } = fluentComponents;

const useStyles = makeStyles({
  // The frame below is drawn on the host, whose padding box is the viewport's
  // border box exactly, so a ring outside the viewport is cut on all four sides
  // and a gutter would float the trace off its frame. It is drawn inward
  // instead, as ./code-block.tsx does for the same situation: a 2px
  // FocusStrokeColorOuter outline over the outer two of an inner ring's three
  // pixels.
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
export function ErrorShell({ action, children, message, title }: PropsWithChildren<{
  action?: ReactNode;
  /** Omitted when a trace is shown: the trace's first line is this sentence. */
  message?: string;
  title: string;
}>) {
  return (
    <ScrollArea axes="vertical" className="floway-error-shell-viewport" contentClassName="h-full">
      {/* Filling the scroller rather than the window: its viewport is shorter
          than the window whenever a scrollbar takes width, so a child measured
          against the window is permanently taller than its container and the bar
          can never retract. */}
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

// The trace scrolls on its own so a long line cannot widen the page under it,
// and is left-aligned against the centred page above. It carries no heading --
// its first line names the error.
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
