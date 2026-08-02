import type { ShouldRevalidateFunctionArgs } from 'react-router';

// Position within a page -- tab, model, range, hidden series -- is kept in the
// search, and every write is a navigation. Those loaders read the search once to
// seed first paint; left to the default, a tab click would refetch everything.
export const revalidateOnPathnameChange = ({ currentUrl, defaultShouldRevalidate, nextUrl }: ShouldRevalidateFunctionArgs) =>
  currentUrl.pathname === nextUrl.pathname ? false : defaultShouldRevalidate;
