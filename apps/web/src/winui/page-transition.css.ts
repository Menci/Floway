// The page transition, drawn as WinUI 3's EntranceNavigationTransitionInfo,
// over the leaving and arriving frames that ../../routes/dashboard.tsx stacks
// in one grid cell. The View Transition API would snapshot the outgoing page
// instead and make those frames unnecessary; they are here so the transition
// does not depend on its availability.

// The leg that owns how long the outgoing frame stays mounted: it is dropped
// when this animation ends, so ../components/page-frames.tsx recognises it by
// name off the animation event.
export const PAGE_LEAVE_ANIMATION = 'floway-page-leave';

export const pageTransitionCss = `
  /* The legs are strictly sequential, so the entering animation fills forwards:
     a delayed animation's default fill leaves the element at its own resting
     style, overlapping the two pages for the length of the delay. Incoming
     opacity is two discrete key frames that never interpolate, as in the
     source. */
  .floway-page-leaving {
    animation: ${PAGE_LEAVE_ANIMATION} var(--winui-page-leave-duration)
      var(--winui-page-leave-easing) forwards;
    pointer-events: none;
  }
  .floway-page-entering {
    animation: floway-page-enter var(--winui-page-enter-duration)
      var(--winui-page-enter-easing) var(--winui-page-leave-duration) forwards;
    opacity: 0;
  }
  @keyframes ${PAGE_LEAVE_ANIMATION} { to { opacity: 0; } }
  @keyframes floway-page-enter {
    from { opacity: 1; translate: 0 var(--winui-page-enter-offset); }
    to { opacity: 1; translate: none; }
  }

  /* Only the resting position is stated here; ../../routes/dashboard.tsx starts
     the reload entrance on the element, because a CSS animation takes its start
     time from the frame its style was recalculated in rather than the frame it
     is first painted in -- this frame is recalculated mid-hydration, so 84ms of
     its 300 had already run by the time it reached the screen. That script also
     adds this class, so nothing holds the frame down unless the thing that
     lifts it already exists, and the animation's forwards fill outranks this
     declaration afterwards. */
  .floway-page-entrance {
    translate: 0 var(--winui-page-enter-offset);
  }

  /* Both legs are clamped rather than dropped so the pair still runs in order
     and still fires; the reload entrance is skipped instead, because script
     starts it and script can ask. Arriving from below is motion animation by
     WCAG's definition, which turns on perceived position.
     https://github.com/w3c/wcag/blob/900ea026b967bc306a2cdbe0c586330a508d6759/guidelines/terms/21/motion-animation.html#L3-L4 */
  @media (prefers-reduced-motion: reduce) {
    .floway-page-leaving { animation-duration: 0.01ms; }
    .floway-page-entering {
      animation-delay: 0.01ms;
      animation-duration: 0.01ms;
    }
  }
`;
