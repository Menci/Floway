// The WinUI page transition (../winui/page-transition.css.ts) is opt-in, and
// this is the opt: spread it into the `Link`, `useLinkClickHandler` or
// `navigate` options at a site that leaves the page. The router cannot tell a
// page change from a URL rewrite, and pages that keep filter and selection state
// in the query string navigate on almost every interaction -- animating those
// would put a page transition on a checkbox. `replace: true` marks many of the
// same sites but is a separate decision, so neither is derived from the other.
//
// The mark rides on the history entry rather than the navigation call: what
// reads it is the render after the commit, and that also answers the back
// button, since returning to an entry reached by a page change is itself one.
const PAGE_CHANGE = 'flowayPageChange';
export const pageNavigation = { state: { [PAGE_CHANGE]: true } } as const;

export const isPageChange = (state: unknown): boolean =>
  typeof state === 'object' && state !== null && PAGE_CHANGE in state;
