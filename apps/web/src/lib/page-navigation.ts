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
// `viewTransition` asks React Router to commit the location inside
// `document.startViewTransition`, which is what gives the outgoing view a
// snapshot to animate out of. A browser without the API runs the callback
// straight through and the swap is instant.
export const pageNavigation = { viewTransition: true } as const;
