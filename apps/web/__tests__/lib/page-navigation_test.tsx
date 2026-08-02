import { act } from '@testing-library/react';
import { createMemoryRouter, RouterProvider, useLocation, useNavigate, type NavigateOptions } from 'react-router';
import { describe, expect, it } from 'vitest';

import { isPageChange, pageNavigation, useEntryRewrite } from '../../src/lib/page-navigation';
import { renderInApp } from '../render';

// What decides the page transition is the render after the commit, so this
// reads the mark the way `page-frames.tsx` does -- through `useLocation` on a
// committed entry -- rather than through the options object that was handed to
// `navigate`. The rewrite is issued from the page too, since the options it
// goes out with are the ones the entry it is on produces.
const Probe = () => {
  const navigate = useNavigate();
  const rewrite = useEntryRewrite();
  return <>
    <span>{isPageChange(useLocation().state) ? 'page change' : 'same page'}</span>
    <button onClick={() => void navigate('?kind=copilot', rewrite)} type="button">rewrite</button>
  </>;
};

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
    const { getByRole, getByText } = renderRouter();

    await act(async () => { getByRole('button').click(); });

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

  it('still reads a page change after the returned-to page rewrote its own query string', async () => {
    const { router, getByRole, getByText } = renderRouter();

    await navigate(router, '/upstreams/new', pageNavigation);
    await act(async () => { getByRole('button').click(); });
    await navigate(router, '/keys', pageNavigation);
    await back(router);

    expect(getByText('page change')).toBeTruthy();
  });
});
