// The instantaneous answer, for the code that starts an animation: a Web
// Animations call or a `scrollTo` needs to know what the preference is at the
// moment it runs, and it does not want a re-render when the preference later
// changes -- the animation it already started is over by then. That is a
// different question from the one `useMediaQuery` answers, which is reactive
// state a component renders from, so the two stay separate; what they must not
// do is spell the query differently.
export const prefersReducedMotion = (): boolean =>
  window.matchMedia('(prefers-reduced-motion: reduce)').matches;
