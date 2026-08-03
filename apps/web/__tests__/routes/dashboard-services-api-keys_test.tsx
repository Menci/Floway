import { act } from '@testing-library/react';
import { createMemoryRouter, Outlet, RouterProvider } from 'react-router';
import { describe, expect, it, vi } from 'vitest';

import { OutcomeToastProvider } from '../../src/components/ui/outcome-toast';
import DashboardServicesApiKeys from '../../src/routes/dashboard-services-api-keys';
import { stubLocalStorage } from '../local-storage-stub';
import { renderInApp } from '../render';

// Which key the Agent Setup card is set up for outlives a visit, so the page
// stores the id the operator picked. What may not happen is the page throwing
// that away on its own: a visit that could not load the key list resolves no
// selection, and the stored id has to survive it for the next visit that can.
const loaderData = {
  keys: null,
  upstreams: null,
  models: null,
  error: 'Failed to fetch',
  selectedKeyId: '',
  setupError: null,
  setupLease: null,
};

const renderPage = () => {
  const router = createMemoryRouter([
    {
      path: '/',
      Component: () => <OutcomeToastProvider><Outlet context={{ user: { id: 1, username: 'admin', role: 'admin', upstreamIds: null } }} /></OutcomeToastProvider>,
      children: [{
        index: true,
        Component: () => <DashboardServicesApiKeys
          loaderData={loaderData}
          matches={[] as never}
          params={{}}
        />,
      }],
    },
  ], { initialEntries: ['/'] });
  return renderInApp(<RouterProvider router={router} />);
};

describe('API keys page', () => {
  const storage = stubLocalStorage();

  it('keeps the stored key selection through a visit that could not load the keys', async () => {
    storage.set('floway-agent-setup-selected-key', 'stored-key');
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({}, { status: 500 })));

    await act(async () => { renderPage(); });

    expect(storage.get('floway-agent-setup-selected-key')).toBe('stored-key');
  });
});
