import { useMemo } from 'react';
import { useLocation, type NavigateOptions } from 'react-router';

// The WinUI page transition (../winui/page-transition.css.ts) is opt-in because
// the router cannot tell a page change from a URL rewrite, and pages holding
// filter and selection state in the query string navigate on almost every
// interaction -- animating those would put a page transition on a checkbox.
// The mark rides on the history entry rather than the navigation call: what
// reads it is the render after the commit, and that also answers the back
// button, since returning to an entry reached by a page change is itself one.
const PAGE_CHANGE = 'flowayPageChange';
export const pageNavigation = { state: { [PAGE_CHANGE]: true } } as const;

export const isPageChange = (state: unknown): boolean =>
  typeof state === 'object' && state !== null && PAGE_CHANGE in state;

// The options a page replaces its own history entry with -- restating its query
// string, or standing in the URL of the record it just created. An entry
// replaced with a bare { replace: true } keeps no state, so the mark the page
// was entered with is dropped and a later back navigation into it plays
// nothing. Carrying the entry's own state forward leaves its provenance alone;
// what keeps the rewrite itself from reading as a page change is the replace,
// which ../components/page-frames.tsx tests for.
export const useEntryRewrite = (): NavigateOptions => {
  const state: unknown = useLocation().state;
  // Stable per entry, so an effect may hold this in its dependencies.
  return useMemo(() => ({ replace: true, state }), [state]);
};
