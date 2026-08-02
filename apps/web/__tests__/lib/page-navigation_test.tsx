import { act } from '@testing-library/react';
import { createMemoryRouter, RouterProvider, useLocation, type NavigateOptions } from 'react-router';
import { describe, expect, it } from 'vitest';

import { isPageChange, pageNavigation } from '../../src/lib/page-navigation';
import { renderInApp } from '../render';

// What decides the page transition is the render after the commit, so this
// reads the mark the way `page-frames.tsx` does -- through `useLocation` on a
// committed entry -- rather than through the options object that was handed to
// `navigate`.
const Probe = () => <span>{isPageChange(useLocation().state) ? 'page change' : 'same page'}</span>;

const renderRouter = () => {
  const router = createMemoryRouter(
    ['/upstreams', '/upstreams/new', '/keys'].map(path => ({ path, Component: Probe })),
    { initialEntries: ['/upstreams'] },
  );
  return { router, ...renderInApp(<RouterProvider router={router} />) };
};

type Router = ReturnType<typeof renderRouter>['router'];

const navigate = async (router: Router, to: string, options?: NavigateOptions) => {
  await act(async () => { await router.navigate(to, options); });
};

const back = async (router: Router) => { await act(async () => { await router.navigate(-1); }); };

describe('page change opt-in', () => {
  it('marks a navigation that asked for the transition', async () => {
    const { router, getByText } = renderRouter();
    expect(getByText('same page')).toBeTruthy();

    await navigate(router, '/upstreams/new', pageNavigation);

    expect(getByText('page change')).toBeTruthy();
  });

  it('leaves a filter rewrite of the same page unmarked', async () => {
    const { router, getByText } = renderRouter();

    await navigate(router, '/upstreams?kind=copilot', { replace: true });

    expect(getByText('same page')).toBeTruthy();
  });

  it('leaves a navigation that did not ask for the transition unmarked', async () => {
    const { router, getByText } = renderRouter();

    await navigate(router, '/keys');

    expect(getByText('same page')).toBeTruthy();
  });

  it('still reads a page change when the back button returns to one', async () => {
    const { router, getByText } = renderRouter();

    await navigate(router, '/upstreams/new', pageNavigation);
    await navigate(router, '/keys', pageNavigation);
    await back(router);

    expect(getByText('page change')).toBeTruthy();
  });

  // A filter rewrite replaces the history entry, and the replacement carries no
  // state, so the mark the page was entered with is gone from the entry that
  // remains. Going back to that page from a later one then reads as a same-page
  // navigation and plays no transition. Recorded in `data/backlog.md`; the
  // rewrite would have to carry the current entry's state forward.
  it.todo('still reads a page change after the returned-to page rewrote its own query string');
});
