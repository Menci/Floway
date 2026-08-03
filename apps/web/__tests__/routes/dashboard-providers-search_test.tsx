import { act, screen } from '@testing-library/react';
import { createMemoryRouter, Outlet, RouterProvider } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { OutcomeToastProvider } from '../../src/components/ui/outcome-toast';
import DashboardProvidersSearch, { clientLoader } from '../../src/routes/dashboard-providers-search';
import { useAuthStore } from '../../src/stores/auth-store';
import { stubLocalStorage } from '../local-storage-stub';
import { renderInApp } from '../render';

stubLocalStorage();

afterEach(() => {
  useAuthStore.getState().clear();
  vi.unstubAllGlobals();
});

describe('who search settings open for', () => {
  it('redirects an operator away before calling an admin endpoint', async () => {
    const user = { id: 2, username: 'operator', isAdmin: false, upstreamIds: null };
    useAuthStore.getState().primeFromLogin({ token: 'operator-session', user });
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);

    const thrown = await clientLoader().then(() => null, (caught: unknown) => caught);
    expect(thrown).toBeInstanceOf(Response);
    expect((thrown as Response).status).toBe(302);
    expect((thrown as Response).headers.get('location')).toBe('/dashboard/services/api-keys');
    expect(fetch).not.toHaveBeenCalled();
  });
});

const loaderData = {
  config: {
    provider: 'tavily' as const,
    tavily: { apiKey: 'key' },
    microsoftWebIq: { apiKey: '' },
    jina: { apiKey: '' },
    passthroughOpenAiSearch: { enabled: false, upstreamId: '', model: '' },
  },
  upstreams: [],
  models: [],
  error: null,
};

const pressTest = async (respond: () => Response) => {
  vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(respond())));
  const router = createMemoryRouter([
    {
      path: '/',
      Component: () => <OutcomeToastProvider><Outlet /></OutcomeToastProvider>,
      children: [{
        index: true,
        Component: () => <DashboardProvidersSearch
          loaderData={loaderData}
          matches={[] as never}
          params={{}}
        />,
      }],
    },
  ], { initialEntries: ['/'] });

  await act(async () => { renderInApp(<RouterProvider router={router} />); });
  await act(async () => { screen.getByRole('button', { name: 'Test Search' }).click(); });
};

describe('what a failed search test says', () => {
  it('reads the probe verdict out of the structured 400 body', async () => {
    await pressTest(() => Response.json({
      ok: false,
      provider: 'tavily',
      query: 'floway',
      error: { code: 'unauthorized', message: 'Invalid API key.' },
    }, { status: 400 }));

    expect(screen.getByText('unauthorized')).toBeTruthy();
    expect(screen.getByText('Invalid API key.')).toBeTruthy();
  });

  it('names what a gateway crash reported, not the envelope around it', async () => {
    await pressTest(() => Response.json({
      error: { type: 'internal_error', name: 'Error', message: 'Search provider registry is empty' },
    }, { status: 500 }));

    expect(screen.getByText('Search provider registry is empty')).toBeTruthy();
    expect(screen.queryByText('[object Object]')).toBeNull();
  });

  it('falls back to the status when the failure carries no JSON at all', async () => {
    await pressTest(() => new Response('<html>Bad gateway</html>', {
      status: 502,
      headers: { 'content-type': 'text/html' },
    }));

    expect(screen.getByText('HTTP 502')).toBeTruthy();
  });
});
