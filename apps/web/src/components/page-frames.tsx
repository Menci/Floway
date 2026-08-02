import { useContext, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import {
  useLocation,
  UNSAFE_DataRouterContext,
  UNSAFE_DataRouterStateContext,
  UNSAFE_LocationContext,
  UNSAFE_NavigationContext,
  UNSAFE_RouteContext,
} from 'react-router';

import { isPageChange } from '../lib/page-navigation';

// The outgoing page, kept on screen while it leaves.
//
// A page transition needs both pages at once, and React Router will not give us
// that. Three things have to be worked around, and each of them bites in a way
// that is worth stating rather than rediscovering.
//
// **The router will not render a tree for any location but the current one.**
// `<Routes location>` is the declarative escape hatch and it does not survive
// contact with framework mode: `RouterProvider` passes its `locationArg` as
// `undefined`, and matching ignores that argument anyway once a data router is
// present, so what renders is a tree with no data, no error boundary and no
// hydrate fallback. Every compiled route module then goes through
// `withComponentProps`, which calls `useLoaderData()` unconditionally. So the
// old page has to be held as the element the router already handed out.
//
// **The element carries its matches but not its data.** `RenderedRoute` passes
// the route context as a PROP, so a held element keeps knowing which route it
// is; but `useLoaderData` reads `state.loaderData[routeId]` out of the LIVE
// router state, and `mergeLoaderData` keeps only the ids the new match set
// contains. A held page therefore re-renders with `undefined` where its data
// was, and every page here destructures that. Hence the five frozen contexts
// below -- they are what the router answers those questions from.
//
// **The freeze has to capture the render in which the page was still current.**
// This is the one that is easy to get wrong and fails loudly. This component
// mounts during the render that navigated AWAY, so reading the contexts here --
// `useState(useContext(X))`, which is the shape every published version of this
// trick uses -- freezes the page that just replaced it. The held page then comes
// up with no data at all, which is precisely the crash the freeze exists to
// prevent. The values are read in `usePageFrames` on every render and handed in.
//
// These contexts are exported under `UNSAFE_` because they are internal, and
// that is the real cost here: a React Router upgrade can move them without a
// deprecation. What protects us is that the failure is loud -- a page with no
// loader data throws on its first navigation -- rather than silent. The
// browser's View Transition API does all of this for us by snapshotting the old
// pixels, and it is the better mechanism where it is available; this exists so
// the transition does not depend on it. Measured against that version, per
// animation frame across the navigation, the two are equally smooth: a 17ms
// median tick either way, and this one drops no frame over 32ms where the
// snapshot version dropped one. Nothing here lays out -- eleven layouts
// totalling 3ms across the whole navigation -- because a page moves on
// `translate` and fades on `opacity` and neither reaches layout.

type RouterContexts = ReturnType<typeof useRouterContexts>;

const useRouterContexts = () => ({
  dataRouter: useContext(UNSAFE_DataRouterContext),
  dataRouterState: useContext(UNSAFE_DataRouterStateContext),
  location: useContext(UNSAFE_LocationContext),
  navigation: useContext(UNSAFE_NavigationContext),
  route: useContext(UNSAFE_RouteContext),
});

// Read where the page is still current. Every render passes through here, so
// the values a page is holding when it is replaced are the ones it was drawn
// with.
//
// Every frame goes through this, the current one included, and that is what
// makes the frame's element type the same before and after it starts leaving.
// React reconciles by type at a position: a page rendered bare while current
// and wrapped once it leaves is a different type under the same key, so the
// whole page would unmount and mount again on the way out -- losing exactly
// the state the frame is being held on screen to show. For the current page
// the providers hand back the values that are already in scope, so it is the
// tree it would be without them.
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
  /** What to draw. The leaving page's is frozen; the current page's is live. */
  node: ReactNode;
  leaving: boolean;
}

/**
 * The frames to draw: the current page, and the page it replaced for as long as
 * that one takes to leave.
 *
 * Three things about the id, all of them load-bearing.
 *
 * It moves only on a page change, never on a URL rewrite. Every navigation gets
 * a new `location.key`, including the `replace` a filter does, so keying frames
 * on that would remount the scroller and everything in it whenever a chart
 * changed its range. An unmarked navigation re-renders in place exactly as it
 * did before any of this existed.
 *
 * The leaving frame keeps the id it already had, so React matches it to the DOM
 * that is already on screen. Held under a new id it would mount afresh: the
 * outgoing page would snap back to its initial state, lose its scroll position
 * and re-run its effects, and only then fade. A page that resets before it
 * leaves is worse than no transition.
 *
 * And the split is derived during render rather than in an effect. An effect
 * lands a frame later, and that frame already shows the new page standing where
 * the old one is supposed to still be -- one frame of the thing the whole
 * mechanism exists to avoid. Setting state during render is React's own answer
 * for deriving from props, and it re-renders before anything is painted.
 */
export const usePageFrames = (outlet: ReactNode, leaveMs: number): PageFrame[] => {
  const location = useLocation();
  const contexts = useRouterContexts();
  const [current, setCurrent] = useState({ id: 0, key: location.key, node: outlet, contexts });
  const [leaving, setLeaving] = useState<{ id: number; node: ReactNode; contexts: RouterContexts } | null>(null);

  if (current.key !== location.key) {
    // Derived from the location during render rather than in an effect: an
    // effect lands a frame later, and that frame would already show the new
    // page where the old one is supposed to still be.
    const pageChange = isPageChange(location.state);
    setLeaving(pageChange ? { id: current.id, node: current.node, contexts: current.contexts } : null);
    setCurrent({ id: pageChange ? current.id + 1 : current.id, key: location.key, node: outlet, contexts });
  }

  useEffect(() => {
    if (!leaving) return;
    const done = window.setTimeout(() => setLeaving(null), leaveMs);
    return () => window.clearTimeout(done);
  }, [leaving, leaveMs]);

  const frames: PageFrame[] = [{ id: current.id, node: <FrozenRoute contexts={contexts}>{outlet}</FrozenRoute>, leaving: false }];
  if (leaving) frames.unshift({ id: leaving.id, node: <FrozenRoute contexts={leaving.contexts}>{leaving.node}</FrozenRoute>, leaving: true });
  return frames;
};
