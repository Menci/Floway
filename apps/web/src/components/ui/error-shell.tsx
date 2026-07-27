import type { PropsWithChildren } from "react";

export function ErrorShell({ children }: PropsWithChildren) {
  return (
    <main className="mx-auto max-w-[960px] pt-16 px-4 pb-4">
      {children}
    </main>
  );
}

export function ErrorStack({ children }: PropsWithChildren) {
  return (
    <pre className="overflow-x-auto p-4 w-full">
      <code>{children}</code>
    </pre>
  );
}
