import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { useSiteSettingsStore } from '../../src/stores/site-settings-store';

const reset = () => useSiteSettingsStore.setState({ siteName: null, loaded: false });

beforeEach(reset);
afterEach(() => vi.unstubAllGlobals());

it('leaves the built-in branding in place when the read fails', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ error: 'unavailable' }, { status: 500 })));

  await useSiteSettingsStore.getState().load();

  expect(useSiteSettingsStore.getState().siteName).toBeNull();
  expect(useSiteSettingsStore.getState().loaded).toBe(false);
});

it('reads the settings once per page load', async () => {
  const fetch = vi.fn(async () => Response.json({ site_name: 'Team Gateway' }));
  vi.stubGlobal('fetch', fetch);

  await useSiteSettingsStore.getState().load();
  await useSiteSettingsStore.getState().load();

  expect(fetch).toHaveBeenCalledTimes(1);
});
