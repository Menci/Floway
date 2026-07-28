import { useSyncExternalStore } from 'react';

export const useMediaQuery = (query: string): boolean => useSyncExternalStore(
  listener => {
    const media = window.matchMedia(query);
    media.addEventListener('change', listener);
    return () => media.removeEventListener('change', listener);
  },
  () => window.matchMedia(query).matches,
  () => false,
);
