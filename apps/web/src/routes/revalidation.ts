import type { ShouldRevalidateFunctionArgs } from 'react-router';

// Where the operator is inside a page -- which tab, which model, which range,
// which series are hidden -- is kept in the search and written with `replace`,
// and every one of those writes is a navigation. The loaders on those pages
// read the search once, to seed first paint; from then on the page owns both
// its state and its own refetches. Left to the default, a tab click would
// refetch everything the page opened with.
export const revalidateOnPathnameChange = ({ currentUrl, defaultShouldRevalidate, nextUrl }: ShouldRevalidateFunctionArgs) =>
  currentUrl.pathname === nextUrl.pathname ? false : defaultShouldRevalidate;
