import { useEffect } from 'react';

// A hidden tab is not being read, so polling it spends the operator's quota on
// data nobody sees and leaves a stale page behind anyway. The tick is skipped
// while hidden and the return to the tab pays for it with one foreground
// refresh: foreground, because the operator is looking now and a failure they
// caused by coming back is one they should see.
export function usePollWhileVisible(
  refresh: (options: { background: boolean }) => Promise<void>,
  intervalMs: number,
) {
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
}
