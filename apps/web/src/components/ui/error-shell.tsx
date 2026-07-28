import type { PropsWithChildren } from 'react';

import { ScrollArea } from './scroll-area';

export function ErrorShell({ children }: PropsWithChildren) {
  return (
    <ScrollArea axes="vertical" className="h-[100dvh]" contentClassName="min-h-full">
      <main className="mx-auto max-w-[960px] min-h-full pt-16 px-4 pb-4">
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
