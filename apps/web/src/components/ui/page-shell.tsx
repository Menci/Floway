import type { PropsWithChildren } from "react";

export function PageShell({ children }: PropsWithChildren) {
  return (
    <main className="min-h-screen p-5 max-sm:p-4 grid place-items-center">
      {children}
    </main>
  );
}
