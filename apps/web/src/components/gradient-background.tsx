import type { PropsWithChildren } from 'react';

export function GradientBackground({ children }: PropsWithChildren) {
  return <div className="floway-gradient-background">{children}</div>;
}
