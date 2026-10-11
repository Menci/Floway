import { useCallback } from 'react';

import { dashboardRangeIsCurrent, type DashboardRange } from '../charts/dashboard-time';
import { usePollWhileVisible } from '../ui/use-poll-while-visible';
import type { RefreshControl } from '../ui/use-refresh';

export const useTelemetryPolling = (poll: RefreshControl['poll'], range: DashboardRange, enabled: boolean): void => {
  const pollCurrentRange = useCallback(async (options: { background: boolean }) => {
    if (dashboardRangeIsCurrent(range, Date.now())) await poll(options);
  }, [poll, range]);
  usePollWhileVisible(pollCurrentRange, 60_000, enabled);
};
