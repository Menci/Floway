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
// that. It destroys the outgoing route's DOM at the commit, and holding the
// element it handed out is not enough on its own: an element carries its
// matches, because `RenderedRoute` passes them as a prop rather than reading
// them from context, but it does not carry the route's data. `useLoaderData`
// reads `state.loaderData[routeId]` out of the live router state, and
// `mergeLoaderData` keeps only the ids the NEW match set contains -- so a held
// page re-renders with `undefined` where its data was, and every page here
// destructures that.
//
// What is frozen here is therefore the five contexts the router answers those
// questions from. `useState` reads its initialiser once, and this component
// mounts once per page it holds, so every value below is the one that was
// current when the page it wraps was. The held tree keeps answering as it did
// then: its data is there, its location is its own, and a relative link inside
// it still resolves against the route it belongs to.
//
// These are the router's internal contexts and are exported under UNSAFE_ for
// that reason. There is no supported way to render a route tree for a location
// other than the current one in framework mode -- `<Routes location>` renders
// without data, and matching ignores the location argument once a data router
// is present -- so this is the seam or nothing.
type RouterContexts = ReturnType<typeof useRouterContexts>;

const useRouterContexts = () => ({
  dataRouter: useContext(UNSAFE_DataRouterContext),
  dataRouterState: useContext(UNSAFE_DataRouterStateContext),
  location: useContext(UNSAFE_LocationContext),
  navigation: useContext(UNSAFE_NavigationContext),
  route: useContext(UNSAFE_RouteContext),
});

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
 * The id is what keeps a URL rewrite cheap. Every navigation gets a new
 * `location.key`, including the `replace` a filter does, so keying on that
 * would remount the scroller and everything in it whenever a chart changed its
 * range. This id moves only when a navigation is marked as a page change, so an
 * unmarked one re-renders in place exactly as it did before any of this.
 *
 * Reciprocally, the leaving frame keeps the id it already had, which is what
 * lets React match it to the DOM that is already on screen. Held under a new
 * id it would mount afresh -- the outgoing page would snap back to its initial
 * state, lose its scroll position and re-run its effects, and only then fade.
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

  const frames: PageFrame[] = [{ id: current.id, node: outlet, leaving: false }];
  if (leaving) frames.unshift({ id: leaving.id, node: <FrozenRoute contexts={leaving.contexts}>{leaving.node}</FrozenRoute>, leaving: true });
  return frames;
};
