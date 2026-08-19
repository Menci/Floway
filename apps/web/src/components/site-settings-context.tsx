import { createContext, useContext } from 'react';

import type { SiteSettings } from '../api/site-settings';

const SiteSettingsContext = createContext<SiteSettings | null>(null);

export function SiteSettingsProvider({ children, value }: { children: React.ReactNode; value: SiteSettings }) {
  return <SiteSettingsContext value={value}>{children}</SiteSettingsContext>;
}

export function useSiteSettings(): SiteSettings {
  const settings = useContext(SiteSettingsContext);
  if (!settings) throw new Error('useSiteSettings must be used within SiteSettingsProvider');
  return settings;
}
