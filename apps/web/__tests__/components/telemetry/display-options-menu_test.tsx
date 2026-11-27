import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { TelemetryDisplayOptionsMenu } from '../../../src/components/telemetry/display-options-menu';
import { OutcomeToastProvider } from '../../../src/components/ui/outcome-toast';
import { useAuthStore } from '../../../src/stores/auth-store';
import { stubLocalStorage } from '../../local-storage-stub';
import { renderInApp } from '../../render';
import { primeDefaultSession } from '../../test-session';
import { defaultUserPreferences } from '@floway-dev/protocols/browser';

stubLocalStorage();

beforeEach(() => {
  useAuthStore.getState().clear();
  primeDefaultSession();
});

afterEach(() => {
  cleanup();
  useAuthStore.getState().clear();
  vi.unstubAllGlobals();
});

const renderMenu = () => renderInApp(
  <OutcomeToastProvider>
    <TelemetryDisplayOptionsMenu />
  </OutcomeToastProvider>,
);

describe('TelemetryDisplayOptionsMenu', () => {
  it('applies toggles optimistically and persists them in the background', async () => {
    const fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const patch = JSON.parse(String(init?.body)) as Record<string, boolean>;
      return Response.json({ preferences: { ...defaultUserPreferences, ...patch } });
    });
    vi.stubGlobal('fetch', fetch);

    renderMenu();
    fireEvent.click(screen.getByRole('button', { name: 'Display options' }));
    const foldItem = await screen.findByRole('menuitemcheckbox', { name: /Fold small series/ });
    expect(foldItem.getAttribute('aria-checked')).toBe('false');

    fireEvent.click(foldItem);
    expect(useAuthStore.getState().session!.user.preferences.foldSmallSeries).toBe(true);

    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    expect(JSON.parse(String((fetch.mock.calls[0] as [string, RequestInit])[1].body))).toEqual({ foldSmallSeries: true });
  });

  it('keeps the toggled state and shows an error toast when saving fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ error: 'Database read-only' }, { status: 503 })));

    renderMenu();
    fireEvent.click(screen.getByRole('button', { name: 'Display options' }));
    fireEvent.click(await screen.findByRole('menuitemcheckbox', { name: /Fold small series/ }));

    await screen.findByText(/Database read-only/);
    expect(useAuthStore.getState().session!.user.preferences.foldSmallSeries).toBe(true);
  });
});
