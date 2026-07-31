import { useCallback, useState } from 'react';

// The flag a list's refresh control reads. It gates the control and every row
// action beside it, so a reload that throws must still clear it: left set, the
// page stays disabled until it is navigated away from.
export function useRefresh(reload: () => Promise<void>) {
  const [refreshing, setRefreshing] = useState(false);
  const refresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await reload();
    } finally {
      setRefreshing(false);
    }
  }, [reload]);
  return { refresh, refreshing };
}
