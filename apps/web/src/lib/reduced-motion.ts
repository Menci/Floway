// The instantaneous answer, for code that starts an animation and does not want
// a re-render when the preference later changes. `useMediaQuery` answers the
// reactive question; the two must spell the query identically.
export const prefersReducedMotion = (): boolean =>
  window.matchMedia('(prefers-reduced-motion: reduce)').matches;
