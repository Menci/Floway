import { fireEvent, screen, waitFor } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { OutcomeToastProvider } from '../../src/components/ui/outcome-toast';
import { i18n, setLanguage } from '../../src/i18n';
import { __testing as mirrorTesting } from '../../src/i18n/ui-text-editor/mirror';
import DashboardSettings from '../../src/routes/dashboard-settings';
import { useAuthStore } from '../../src/stores/auth-store';
import { stubLocalStorage } from '../local-storage-stub';
import { renderInApp } from '../render';
import { defaultUserPreferences } from '@floway-dev/protocols/browser';

stubLocalStorage();

const user = {
  id: 1,
  username: 'admin',
  isAdmin: true,
  canViewPermissions: true,
  canViewUpstreams: true,
  preferences: { ...defaultUserPreferences, mergeModelVariants: true },
};

const renderPage = () => renderInApp(<RouterProvider router={createMemoryRouter([
  { path: '/dashboard/settings', element: <OutcomeToastProvider><DashboardSettings /></OutcomeToastProvider> },
], { initialEntries: ['/dashboard/settings'] })} />);

const reload = vi.fn();

beforeEach(async () => {
  window.localStorage.clear();
  reload.mockReset();
  mirrorTesting.setReloadHandler(reload);
  mirrorTesting.resetBootState(false);
  await setLanguage('en');
  useAuthStore.getState().clear();
  useAuthStore.getState().primeFromLogin({ token: 'session', user });
});

afterEach(() => vi.unstubAllGlobals());

describe('preference form', () => {
  it('saves the draft only after the operator submits it', async () => {
    const fetch = vi.fn(async () => Response.json({ preferences: { ...defaultUserPreferences, quotaDisplay: 'used', mergeModelVariants: true } }));
    vi.stubGlobal('fetch', fetch);
    renderPage();

    const save = screen.getByRole('button', { name: 'Save preferences' });
    // The button stays operable with nothing to save; pressing it sends no request.
    expect(save.getAttribute('aria-disabled')).toBeNull();

    fireEvent.click(screen.getByRole('combobox', { name: 'Quota display' }));
    fireEvent.click(await screen.findByRole('option', { name: 'Usage' }));
    // The draft has not reached the session yet: the rest of the dashboard still reads the saved value.
    expect(useAuthStore.getState().session!.user.preferences.quotaDisplay).toBe('remaining');
    expect(fetch).not.toHaveBeenCalled();

    fireEvent.click(save);
    await waitFor(() => expect(useAuthStore.getState().session!.user.preferences).toEqual({ ...defaultUserPreferences, quotaDisplay: 'used', mergeModelVariants: true }));

    const request = fetch.mock.calls[0] as unknown as [string, RequestInit];
    const url = new URL(request[0], 'http://localhost');
    expect(url.pathname).toBe('/api/users/me/preferences');
    expect(request[1].method).toBe('PATCH');
    expect(JSON.parse(String(request[1].body))).toEqual({ quotaDisplay: 'used', language: null, uiTextEditor: false });
    expect(reload).not.toHaveBeenCalled();
  });

  it('persists UI text editor mode and reloads when toggled', async () => {
    const fetch = vi.fn(async () => Response.json({ preferences: { ...defaultUserPreferences, uiTextEditor: true, mergeModelVariants: true } }));
    vi.stubGlobal('fetch', fetch);
    renderPage();

    fireEvent.click(screen.getByRole('switch', { name: 'UI text editor' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save preferences' }));

    await waitFor(() => expect(useAuthStore.getState().session!.user.preferences.uiTextEditor).toBe(true));
    expect(mirrorTesting.readStored()).toBe(true);
    expect(reload).toHaveBeenCalled();
  });

  it('keeps the saved value when the server refuses the write', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ error: 'Unavailable' }, { status: 503 })));
    renderPage();

    fireEvent.click(screen.getByRole('combobox', { name: 'Quota display' }));
    fireEvent.click(await screen.findByRole('option', { name: 'Usage' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save preferences' }));

    await waitFor(() => expect(screen.getByText('Unavailable')).toBeTruthy());
    expect(useAuthStore.getState().session!.user.preferences.quotaDisplay).toBe('remaining');
    expect(i18n.language).toBe('en');
  });
});
