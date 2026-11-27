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

const renderMenu = (props: Parameters<typeof TelemetryDisplayOptionsMenu>[0]) => renderInApp(
  <OutcomeToastProvider>
    <TelemetryDisplayOptionsMenu {...props} />
  </OutcomeToastProvider>,
);

describe('TelemetryDisplayOptionsMenu', () => {
  it('shows merge option only for model-grouped charts and persists toggles in the background', async () => {
    const fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const patch = JSON.parse(String(init?.body)) as Record<string, boolean>;
      return Response.json({ preferences: { ...defaultUserPreferences, ...patch } });
    });
    vi.stubGlobal('fetch', fetch);
    const onMergeChange = vi.fn();

    const hiddenMerge = renderMenu({ showMergeModelVariants: false });
    fireEvent.click(screen.getByRole('button', { name: 'Display options' }));
    expect(screen.queryByRole('menuitemcheckbox', { name: /Merge model variants/ })).toBeNull();
    expect(screen.getByRole('menuitemcheckbox', { name: /Fold small series/ })).toBeTruthy();
    hiddenMerge.unmount();

    renderMenu({ showMergeModelVariants: true, onMergeModelVariantsChange: onMergeChange });
    fireEvent.click(screen.getByRole('button', { name: 'Display options' }));
    const mergeItem = await screen.findByRole('menuitemcheckbox', { name: /Merge model variants/ });
    expect(mergeItem.getAttribute('aria-checked')).toBe('false');

    fireEvent.click(mergeItem);
    expect(onMergeChange).toHaveBeenCalledWith(true);
    expect(useAuthStore.getState().session!.user.preferences.mergeModelVariants).toBe(true);

    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    expect(JSON.parse(String((fetch.mock.calls[0] as [string, RequestInit])[1].body))).toEqual({ mergeModelVariants: true });
  });

  it('keeps the toggled state and shows an error toast when saving fails', async () => {
    let attempts = 0;
    const fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      attempts += 1;
      if (attempts === 1) return Response.json({ error: 'Database read-only' }, { status: 503 });
      const patch = JSON.parse(String(init?.body)) as Record<string, boolean>;
      return Response.json({ preferences: { ...defaultUserPreferences, ...patch } });
    });
    vi.stubGlobal('fetch', fetch);

    renderMenu({ showMergeModelVariants: true });
    fireEvent.click(screen.getByRole('button', { name: 'Display options' }));
    fireEvent.click(await screen.findByRole('menuitemcheckbox', { name: /Merge model variants/ }));

    await screen.findByText(/Database read-only/);
    expect(useAuthStore.getState().session!.user.preferences.mergeModelVariants).toBe(true);

    fireEvent.click(screen.getByRole('menuitemcheckbox', { name: /Fold small series/ }));
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    expect(useAuthStore.getState().session!.user.preferences).toMatchObject({
      mergeModelVariants: true,
      foldSmallSeries: true,
    });
  });
});
