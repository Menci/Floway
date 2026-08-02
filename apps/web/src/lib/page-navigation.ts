// Which navigations are a page change, and so carry the WinUI page transition
// in ../winui/page-transition.css.ts.
//
// The distinction the router cannot make for us is between going to another
// page and rewriting the URL of the page you are on. Both are navigations, and
// several pages here keep their whole filter and selection state in the query
// string -- the request log, the usage and performance charts, the upstream
// editor's tab and selected model -- so those pages navigate on almost every
// interaction. Animating those would put a page transition on a checkbox.
//
// So the transition is opt-in, and this is the opt: spread it into the `Link`,
// the `useLinkClickHandler` options or the `navigate` options at a site that
// leaves the page. Anything that only rewrites the current page's URL passes
// nothing and gets the swap it has today. Those sites are already recognisable
// by their `replace: true` -- a URL rewrite replaces the entry it is editing
// rather than stacking a new one -- but the two are separate decisions and a
// page change may legitimately replace as well, so neither is derived from the
// other.
//
// The mark rides on the history entry rather than on the navigation call,
// because it has to survive the trip: what reads it is the render that follows
// the commit, and by then the call is over. It also means the browser's back
// button is answered correctly -- returning to an entry that was reached by a
// page change is itself a page change, and the entry remembers that.
const PAGE_CHANGE = 'flowayPageChange';
export const pageNavigation = { state: { [PAGE_CHANGE]: true } } as const;

/** Whether the history entry a location carries was reached by a page change. */
export const isPageChange = (state: unknown): boolean =>
  typeof state === 'object' && state !== null && PAGE_CHANGE in state;
