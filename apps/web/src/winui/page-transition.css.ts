// The page transition, drawn as WinUI 3's EntranceNavigationTransitionInfo --
// the animation a NavigationView frame plays when it navigates forward. Its
// numbers, and what is and is not animated on each leg, are in ../motion.ts.
//
// Nothing here is a Fluent element and nothing outranks anything, so the rules
// name their subject once. What they address is the View Transition
// pseudo-element tree, which the user agent builds outside the document: the
// old frame in this file is a snapshot the browser took before React committed,
// which is the only way this shape is reachable at all. React Router destroys
// the outgoing route's DOM at that commit, and the route it destroys cannot be
// held and re-rendered -- `useLoaderData` reads `state.loaderData[routeId]`
// from the live router state, and `mergeLoaderData` keeps only the ids the new
// match set contains. Which navigations opt in, and why that is a decision the
// router cannot make for us, is in ../lib/page-navigation.ts.
export const pageTransitionCss = `
  /* The frame is the scroller rather than the page inside it, so what the
     browser captures is bounded by the viewport however long the page turns
     out to be, and the navigation pane beside it is left out of the transition
     entirely. Dropping the root's own name is what leaves it out: with no name
     the document is not captured, only the frame is, and everything else --
     the pane, its selection indicator, the mobile header -- updates in the
     same frame the swap happens in, which is what a NavigationView does too.
     Its indicator has its own animation and is not this one's business. */
  :root { view-transition-name: none; }

  /* A reload has no outgoing frame, so the pair below never runs and the
     entrance is stated on the frame itself -- as the same declaration, because
     it is the same leg. The hold in front of it belongs to the arriving frame's
     own storyboard rather than to the departing one: NavigatingTo registers
     opacity 0 at 0 and 1 at 150 as DISCRETE key frames, and the travel likewise
     sits at 140 through 150 before it splines. So a cold start shows nothing for
     150, then the frame whole and already moving. The navigation pane is outside
     the frame and arrives with the document, which is what the hold gives it:
     the pane is on screen before the page comes back into it.

     The wait is also what keeps this smooth. The frame mounts into the busiest
     moment the app has -- hydration, the scroller's own setup, the first
     charts -- and an animation starting there loses its opening frames to that
     work. Starting after it means nothing is being painted while the main
     thread is still busy. */
  .floway-page-transition {
    animation: floway-page-enter var(--winui-page-enter-duration)
      var(--winui-page-enter-easing) var(--winui-page-leave-duration) forwards;
    opacity: 0;
    view-transition-name: floway-page;
  }

  /* The group would animate the frame's box between the two snapshots. Both
     are the viewport, so there is nothing to travel -- but a scrollbar
     appearing or leaving with the page would put a width change here, and a
     frame that resizes under the content sliding into it is not a leg of this
     animation. The box takes its new value at once and the two legs below are
     the whole of the motion. */
  ::view-transition-group(floway-page) { animation: none; }

  /* The two legs are strictly sequential, and the browser is told so twice
     over: a delay alone would not hold the incoming frame back, because the
     default fill leaves a delayed animation's element at its own resting
     style, which for a snapshot is fully opaque. So the incoming frame rests
     at zero and the animation raises it, forwards rather than backwards. That
     is also the literal shape of the source, where the incoming opacity is two
     discrete key frames and never interpolates -- the frame appears whole at
     the instant the outgoing one is gone, and the 140 it travels up is the
     only thing that animates. */
  ::view-transition-old(floway-page) {
    animation: floway-page-leave var(--winui-page-leave-duration)
      var(--winui-page-leave-easing) forwards;
  }
  ::view-transition-new(floway-page) {
    animation: floway-page-enter var(--winui-page-enter-duration)
      var(--winui-page-enter-easing) var(--winui-page-leave-duration) forwards;
    opacity: 0;
  }
  @keyframes floway-page-leave { to { opacity: 0; } }
  @keyframes floway-page-enter {
    from { opacity: 1; translate: 0 var(--winui-page-enter-offset); }
    to { opacity: 1; translate: none; }
  }

  /* A frame arriving from below is motion animation by WCAG's own definition,
     which turns on perceived position, and unlike the router's progress strip
     it reports nothing the destination does not already state -- the reader
     can see which page they have arrived at. Both legs are clamped rather than
     dropped, which is the shape the rest of this layer takes: the pair still
     runs in order and still fires, so the incoming frame is still raised off
     the opacity its own resting style states.
     https://github.com/w3c/wcag/blob/900ea026b967bc306a2cdbe0c586330a508d6759/guidelines/terms/21/motion-animation.html */
  @media (prefers-reduced-motion: reduce) {
    .floway-page-transition {
      animation-delay: 0.01ms;
      animation-duration: 0.01ms;
    }
    ::view-transition-old(floway-page) { animation-duration: 0.01ms; }
    ::view-transition-new(floway-page) {
      animation-delay: 0.01ms;
      animation-duration: 0.01ms;
    }
  }
`;
