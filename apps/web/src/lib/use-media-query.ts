import { useSyncExternalStore } from 'react';

// The one query the app's colour scheme follows, shared by the Fluent theme
// choice and by every surface that has to paint itself to match.
export const DARK_SCHEME_QUERY = '(prefers-color-scheme: dark)';

export const useMediaQuery = (query: string): boolean => useSyncExternalStore(
  listener => {
    const media = window.matchMedia(query);
    media.addEventListener('change', listener);
    return () => media.removeEventListener('change', listener);
  },
  () => window.matchMedia(query).matches,
  () => false,
);
