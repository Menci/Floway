import { useEffect } from 'react';

import type { RefreshControl } from './use-refresh';

// Returning to the tab refreshes in the foreground, not the background: somebody
// is looking now, so a failure on the catch-up refresh is one they should see.
//
// A minute is the interval every page that polls has chosen; naming it here
// keeps the next one from choosing differently by accident.
export const usePollWhileVisible = (refresh: RefreshControl['poll'], intervalMs = 60_000): void => {
  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === 'visible') void refresh({ background: false });
    };
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void refresh({ background: true });
    }, intervalMs);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [intervalMs, refresh]);
};
