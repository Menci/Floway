import type { ShouldRevalidateFunctionArgs } from 'react-router';

// Position within a page -- tab, model, range, hidden series -- is kept in the search, and every write is a
// navigation. These loaders read the search only to seed first paint, so the default would refetch on every tab click.
export const revalidateOnPathnameChange = ({ currentUrl, defaultShouldRevalidate, nextUrl }: ShouldRevalidateFunctionArgs) =>
  currentUrl.pathname === nextUrl.pathname ? false : defaultShouldRevalidate;
