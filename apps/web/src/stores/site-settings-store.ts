import { create } from 'zustand';

import { getSiteSettings } from '../api/site-settings';

interface SiteSettingsStore {
  // null = not read yet, or the deployment stored no override. Both render the
  // built-in wordmark, so the store never invents a name of its own.
  siteName: string | null;
  loaded: boolean;
  setSiteName: (siteName: string | null) => void;
  load: () => Promise<void>;
}

let pending: Promise<void> | null = null;

export const useSiteSettingsStore = create<SiteSettingsStore>((set, get) => ({
  siteName: null,
  loaded: false,

  setSiteName: siteName => set({ siteName, loaded: true }),

  // The name decorates every page, so a failed read leaves the built-in
  // wordmark in place rather than taking the app down with it — that is what a
  // deployment without an override renders anyway. The settings page reads the
  // same endpoint itself, and reports a failure before offering to write,
  // rather than treating it as an unset name.
  load: async () => {
    if (get().loaded) return;
    pending ??= getSiteSettings()
      .then(result => {
        if (!result.error) set({ siteName: result.data.site_name, loaded: true });
      })
      .finally(() => { pending = null; });
    await pending;
  },
}));
