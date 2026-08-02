import { useEffect } from 'react';

import type { RefreshControl } from './use-refresh';

// Ticks are skipped while the tab is hidden, and the return to it pays for that
// with one FOREGROUND refresh -- somebody is looking now, so a failure caused by
// coming back is one they should see.
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
