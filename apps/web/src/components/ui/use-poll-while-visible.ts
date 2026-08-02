import { useEffect } from 'react';

import type { RefreshControl } from './use-refresh';

// A hidden tab is not being read, so polling it spends the operator's quota on
// data nobody sees and leaves a stale page behind anyway. The tick is skipped
// while hidden and the return to the tab pays for it with one foreground
// refresh: foreground, because the operator is looking now and a failure they
// caused by coming back is one they should see.
//
// It takes `useRefresh`'s driven run, so a polling page states its reload once
// and gets the abort, the supersede and the in-flight flag with it instead of
// writing a second copy of them. A minute is the interval every page that polls
// has chosen; naming it here keeps the next one from choosing differently by
// accident.
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
