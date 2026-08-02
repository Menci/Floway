// The page transition, drawn as WinUI 3's EntranceNavigationTransitionInfo. Its
// numbers are in ../motion.ts.
//
// The rules address a pair of frames stacked in one grid cell by
// ../../routes/dashboard.tsx: the page that is leaving and the page that is
// arriving, both real DOM. The browser's View Transition API would snapshot the
// outgoing page instead and make the frames unnecessary; they are here so the
// transition does not depend on its availability.
export const pageTransitionCss = `
  /* The two legs are strictly sequential. The arriving page rests at zero and
     the animation raises it, filling forwards rather than backwards, because a
     delayed animation's default fill leaves the element at its own resting
     style and the two pages would overlap for exactly the length of the delay.
     That is also the literal shape of the source, where the incoming opacity is
     two discrete key frames and never interpolates.

     The leaving page's markup is inert and aria-hidden; pointer-events covers
     the pointer the way painting does. */
  .floway-page-leaving {
    animation: floway-page-leave var(--winui-page-leave-duration)
      var(--winui-page-leave-easing) forwards;
    pointer-events: none;
  }
  .floway-page-entering {
    animation: floway-page-enter var(--winui-page-enter-duration)
      var(--winui-page-enter-easing) var(--winui-page-leave-duration) forwards;
    opacity: 0;
  }
  @keyframes floway-page-leave { to { opacity: 0; } }
  @keyframes floway-page-enter {
    from { opacity: 1; translate: 0 var(--winui-page-enter-offset); }
    to { opacity: 1; translate: none; }
  }

  /* A reload has no outgoing page, so the frame plays the incoming leg on its
     own, with no wait in front of it.

     Only the resting position is stated here. The animation itself is started
     from ../../routes/dashboard.tsx, on the element, because a CSS animation
     takes its start time from the frame its style was recalculated in rather
     than the frame it is first painted in -- and this frame's style is
     recalculated in the middle of hydration, so by the time it reached the
     screen the animation had already run 84ms of its 300. Starting it from
     script lets it start on a frame that paints.

     A forwards fill is what holds the end state against this rule afterwards:
     an animation's fill outranks the declaration it is filling over. The class
     is added by that same script rather than written in the markup, so nothing
     holds the frame down unless the thing that lifts it already exists. */
  .floway-page-entrance {
    translate: 0 var(--winui-page-enter-offset);
  }

  /* A page arriving from below is motion animation by WCAG's definition, which
     turns on perceived position. Both legs are clamped rather than dropped so
     the pair still runs in order and still fires; the reload entrance is not
     clamped but skipped, because script starts it and script can ask.
     https://github.com/w3c/wcag/blob/900ea026b967bc306a2cdbe0c586330a508d6759/guidelines/terms/21/motion-animation.html#L3-L4 */
  @media (prefers-reduced-motion: reduce) {
    .floway-page-leaving { animation-duration: 0.01ms; }
    .floway-page-entering {
      animation-delay: 0.01ms;
      animation-duration: 0.01ms;
    }
  }
`;
