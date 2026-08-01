// The error shell's layout is stated here rather than in utility classes, and
// it is the third surface to need that -- the boot screen and the gradient
// behind it are the others. All three are shown before the stylesheet has arrived: in dev that is
// well over a second, and an error page is the one screen most likely to be
// reached in exactly that window, since a failure is often what made the load
// slow. Left to utilities it renders unstyled -- the heading left-aligned over
// centred buttons, which is what the boot screen's own critical CSS exists to
// avoid for itself.
export const errorShellCss = `
  .floway-error-shell {
    display: grid;
    align-content: center;
    justify-items: center;
    gap: 24px;
    height: 100%;
    min-height: max-content;
    margin: 0 auto;
    max-width: 720px;
    padding: 64px 24px;
  }
  .floway-error-shell > * { min-width: 0; max-width: 100%; }
  .floway-error-shell-viewport { height: 100dvh; }
  .floway-error-shell-stack { display: grid; gap: 6px; }
  .floway-error-shell-stack > * { margin: 0; }
  .floway-error-shell-actions { display: flex; flex-wrap: wrap; justify-content: center; gap: 8px; }
`;
