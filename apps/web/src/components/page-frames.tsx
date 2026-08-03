import { useContext, useState } from 'react';
import type { AnimationEventHandler, ReactNode } from 'react';
import {
  NavigationType,
  useLocation,
  useNavigationType,
  UNSAFE_DataRouterContext,
  UNSAFE_DataRouterStateContext,
  UNSAFE_LocationContext,
  UNSAFE_NavigationContext,
  UNSAFE_RouteContext,
} from 'react-router';

import { isPageChange } from '../lib/page-navigation';
import { PAGE_LEAVE_ANIMATION } from '../winui/page-transition.css';

// The outgoing page, kept on screen while it leaves. The browser's View
// Transition API would snapshot it for us; this exists so the transition does
// not depend on it.
//
// `<Routes location>` cannot render the old location under framework mode:
// `RouterProvider` passes `locationArg` as `undefined` and matching ignores it
// once a data router is present, so the tree renders with no loader data, and
// `withComponentProps` calls `useLoaderData()` unconditionally. So the old page
// is held as the element the router already handed out. That element carries
// its route context as a prop, but `useLoaderData` reads
// `state.loaderData[routeId]` out of the LIVE state, which `mergeLoaderData`
// has already narrowed to the new match set -- hence the five frozen contexts.
//
// The contexts must be captured while the page is still current. This component
// mounts during the render that navigated AWAY, so `useState(useContext(X))`
// here -- the shape every published version of this trick uses -- freezes the
// page that just replaced it, and the held page comes up with no data at all.
// They are read in `usePageFrames` on every render and handed in.

type RouterContexts = ReturnType<typeof useRouterContexts>;

const useRouterContexts = () => ({
  dataRouter: useContext(UNSAFE_DataRouterContext),
  dataRouterState: useContext(UNSAFE_DataRouterStateContext),
  location: useContext(UNSAFE_LocationContext),
  navigation: useContext(UNSAFE_NavigationContext),
  route: useContext(UNSAFE_RouteContext),
});

// The current page is wrapped too, with the values already in scope: React
// reconciles by type at a position, so a page rendered bare while current and
// wrapped once it leaves would unmount and remount on the way out, losing the
// state the frame is held on screen to show.
function FrozenRoute({ contexts, children }: { contexts: RouterContexts; children: ReactNode }) {
  return <UNSAFE_DataRouterContext.Provider value={contexts.dataRouter}>
    <UNSAFE_DataRouterStateContext.Provider value={contexts.dataRouterState}>
      <UNSAFE_LocationContext.Provider value={contexts.location}>
        <UNSAFE_NavigationContext.Provider value={contexts.navigation}>
          <UNSAFE_RouteContext.Provider value={contexts.route}>
            {children}
          </UNSAFE_RouteContext.Provider>
        </UNSAFE_NavigationContext.Provider>
      </UNSAFE_LocationContext.Provider>
    </UNSAFE_DataRouterStateContext.Provider>
  </UNSAFE_DataRouterContext.Provider>;
}

export interface PageFrame {
  /** Stable across a URL rewrite, new on a page change. */
  id: number;
  node: ReactNode;
  leaving: boolean;
  /**
   * Belongs on the element that carries the transition classes: the leaving
   * frame is dropped when its own leave animation ends, so its lifetime is the
   * animation's rather than a second statement of the animation's length.
   */
  onAnimationEnd: AnimationEventHandler<HTMLElement>;
}

/**
 * The frames to draw: the current page, and the page it replaced for as long as
 * that one takes to leave.
 *
 * The id moves only on a page change, never on a URL rewrite. Every navigation
 * gets a new `location.key`, including the `replace` a filter does, so keying
 * frames on that would remount the scroller and everything in it whenever a
 * chart changed its range.
 *
 * The leaving frame keeps the id it already had, so React matches it to the DOM
 * already on screen. Held under a new id it would mount afresh: the outgoing
 * page would snap back to its initial state, lose its scroll position and re-run
 * its effects, and only then fade.
 */
export const usePageFrames = (outlet: ReactNode): PageFrame[] => {
  const location = useLocation();
  const navigationType = useNavigationType();
  const contexts = useRouterContexts();
  const [current, setCurrent] = useState({ id: 0, key: location.key, node: outlet, contexts });
  const [leaving, setLeaving] = useState<{ id: number; node: ReactNode; contexts: RouterContexts } | null>(null);

  if (current.key !== location.key) {
    // Derived from the location during render rather than in an effect: an
    // effect lands a frame later, and that frame would already show the new
    // page where the old one is supposed to still be.
    //
    // A rewrite carries the entry's state forward (../lib/page-navigation.ts),
    // so the mark alone no longer separates arriving at a page from restating
    // its URL; what separates them is that a rewrite replaces the entry it is
    // already on, while entering and going back push and pop.
    const pageChange = navigationType !== NavigationType.Replace && isPageChange(location.state);
    setLeaving(pageChange ? { id: current.id, node: current.node, contexts: current.contexts } : null);
    setCurrent({ id: pageChange ? current.id + 1 : current.id, key: location.key, node: outlet, contexts });
  }

  // The frame is dropped by the animation that fades it, not by a timer of the
  // same length: a clamped animation -- what a request for reduced motion turns
  // the fade into -- would otherwise leave a fully mounted, invisible copy of
  // the page running its effects and its polling for the rest of the timer. The
  // page inside the frame animates too, so only this element's own leave
  // animation counts.
  const onAnimationEnd: AnimationEventHandler<HTMLElement> = event => {
    if (event.target !== event.currentTarget || event.animationName !== PAGE_LEAVE_ANIMATION) return;
    setLeaving(null);
  };

  const frames: PageFrame[] = [{ id: current.id, node: <FrozenRoute contexts={contexts}>{outlet}</FrozenRoute>, leaving: false, onAnimationEnd }];
  if (leaving) frames.unshift({ id: leaving.id, node: <FrozenRoute contexts={leaving.contexts}>{leaving.node}</FrozenRoute>, leaving: true, onAnimationEnd });
  return frames;
};
