import type { PropsWithChildren } from 'react';

import { ScrollArea } from './scroll-area';
import { fluentComponents } from '../../fluent';

const { Text } = fluentComponents;

// The app's error surface: the one page that renders without the dashboard
// around it. It states the type itself rather than taking classes from the
// boundary, so the heading and the line under it land on the same ramp a page
// header uses instead of falling to the user agent's `2em` bold.
export function ErrorShell({ children, message, title }: PropsWithChildren<{ message: string; title: string }>) {
  return (
    <ScrollArea axes="vertical" className="h-[100dvh]" contentClassName="min-h-full">
      <main className="mx-auto grid max-w-[960px] min-h-full content-start gap-4 pt-16 px-4 pb-4">
        <div className="grid gap-1.5">
          <Text as="h1" className="m-0" size={700} weight="semibold">{title}</Text>
          <Text as="p" className="m-0 text-fui-fg2" size={300}>{message}</Text>
        </div>
        {children}
      </main>
    </ScrollArea>
  );
}

export function ErrorStack({ children }: PropsWithChildren) {
  return (
    <ScrollArea axes="horizontal" className="w-full">
      <pre className="p-4 w-max min-w-full"><code>{children}</code></pre>
    </ScrollArea>
  );
}
