import { act } from '@testing-library/react';
import { createMemoryRouter, Outlet, RouterProvider } from 'react-router';
import { describe, expect, it, vi } from 'vitest';

import DashboardMonitorRequests from '../../src/routes/dashboard-monitor-requests';
import { renderInApp } from '../render';

// The shape a background refresh leaves behind when the account genuinely holds
// no key with dump retention and the poll that re-read them failed: an empty
// list carrying an error. Null would be a fetch that never landed a list at
// all, which the page reports differently.
const loaderData = {
  collected: null,
  error: 'HTTP 500',
  keys: [],
  record: null,
  recordError: null,
  records: [],
  recordsError: null,
  selectedKeyId: null,
};

const renderPage = () => {
  const router = createMemoryRouter([
    {
      path: '/',
      Component: () => <Outlet />,
      children: [{
        index: true,
        Component: () => <DashboardMonitorRequests
          loaderData={loaderData}
          matches={[] as never}
          params={{}}
        />,
      }],
    },
  ], { initialEntries: ['/'] });
  return renderInApp(<RouterProvider router={router} />);
};

describe('requests page', () => {
  it('reports a refresh failure that arrived over an empty key list', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({}, { status: 500 })));

    let view!: ReturnType<typeof renderPage>;
    await act(async () => { view = renderPage(); });

    expect(view.queryByText('HTTP 500')).not.toBeNull();
  });
});
