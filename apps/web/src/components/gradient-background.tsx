import type { PropsWithChildren } from 'react';

export const gradientBackgroundCriticalCss = `
  .floway-gradient-background {
    background-image: radial-gradient(circle at 50% 0%, #ffffff 0, #f7fbff 36%, transparent 64%), linear-gradient(180deg, #f6f8fb 0%, #eef2f6 100%);
    min-height: 100vh;
  }
  @media (prefers-color-scheme: dark) {
    .floway-gradient-background {
      background-image: radial-gradient(circle at 50% 0%, #2d2d2d 0, #242424 38%, transparent 68%), linear-gradient(180deg, #1f1f1f 0%, #171717 100%);
    }
  }
`;

export function GradientBackground({ children }: PropsWithChildren) {
  return <div className="floway-gradient-background">{children}</div>;
}
