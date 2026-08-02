// The page transition, drawn as WinUI 3's EntranceNavigationTransitionInfo --
// the animation a NavigationView frame plays when it navigates forward. Its
// numbers, and what is and is not animated on each leg, are in ../motion.ts.
//
// Nothing here is a Fluent element and nothing outranks anything, so the rules
// name their subject once. What they address is a pair of frames stacked in one
// grid cell by ../../routes/dashboard.tsx: the page that is leaving and the page
// that is arriving, both real DOM. ../../components/page-frames.tsx says how the
// leaving one goes on rendering after the router has moved past it, and
// ../../lib/page-navigation.ts says which navigations are page changes at all.
//
// The browser's View Transition API would snapshot the outgoing page for us and
// make all of that unnecessary, and this was built on it first. It is the
// better mechanism where it is available; the frames are here so the transition
// does not depend on it.
export const pageTransitionCss = `
  /* The two legs are strictly sequential. The arriving page rests at zero and
     the animation raises it, forwards rather than backwards, because a delayed
     animation's default fill leaves the element at its own resting style and the
     two pages would overlap for exactly the length of the delay. That is also
     the literal shape of the source, where the incoming opacity is two discrete
     key frames and never interpolates: the page appears whole at the instant the
     outgoing one is gone, and the 140 it travels up is the only thing that
     animates.

     The leaving page takes no pointer while it goes. Its markup is inert and
     aria-hidden as well, so it is out of reach of a click, of the tab order and
     of a screen reader; this covers the pointer the way painting does. */
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

  /* A reload has no outgoing page, so the pair above never runs and the frame
     plays the incoming leg on its own. No wait in front of it, and no hold: the
     first frame the reader sees is the animation's own first frame. The
     navigation pane arrives with the document and does not animate; it is the
     fixed thing the page comes into.

     Only the resting position is stated here. The animation itself is started
     from ../../routes/dashboard.tsx, on the element, because a CSS animation
     takes its start time from the frame its style was recalculated in rather
     than the frame it is first painted in -- and this frame's style is
     recalculated in the middle of hydration, so by the time it reached the
     screen the animation had already run 84ms of its 300 and arrived most of
     the way home. Starting it from script lets it start on a frame that paints.

     A forwards fill is what holds the end state against this rule afterwards:
     an animation's fill outranks the declaration it is filling over. The class
     is added by that same script rather than written in the markup, so nothing
     holds the frame down unless the thing that lifts it already exists. */
  .floway-page-entrance {
    translate: 0 var(--winui-page-enter-offset);
  }

  /* A page arriving from below is motion animation by WCAG's own definition,
     which turns on perceived position, and unlike the router's progress strip it
     reports nothing the destination does not already state -- the reader can see
     which page they have arrived at. Both legs are clamped rather than dropped,
     which is the shape the rest of this layer takes: the pair still runs in
     order and still fires, so the arriving page is still raised off the opacity
     its own resting style states, and the leaving one is still removed on time.
     The reload entrance is not clamped but skipped, because script starts it and
     script can ask.
     https://github.com/w3c/wcag/blob/900ea026b967bc306a2cdbe0c586330a508d6759/guidelines/terms/21/motion-animation.html */
  @media (prefers-reduced-motion: reduce) {
    .floway-page-leaving { animation-duration: 0.01ms; }
    .floway-page-entering {
      animation-delay: 0.01ms;
      animation-duration: 0.01ms;
    }
  }
`;
