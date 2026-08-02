import { useCallback, useEffect, useRef, useState } from 'react';

// Overlapping reloads are aborted rather than ignored, so a superseded request
// stops at the transport instead of running to completion and landing last.
//
// `reload` threads the signal into its calls (`$get(query, { init: { signal }
// })`) and, after awaiting, must return without writing state if it aborted.
// Unmounting aborts too. It also receives whether anybody asked for the run: a
// background run must not clear a failure nobody has read yet.
export interface RefreshControl {
  refresh: () => Promise<void>;
  /** The same run, told who asked for it; see ./use-poll-while-visible.ts. */
  poll: (options: { background: boolean }) => Promise<void>;
  refreshing: boolean;
}

export const useRefresh = (
  reload: (signal: AbortSignal, options: { background: boolean }) => Promise<void>,
): RefreshControl => {
  const [refreshing, setRefreshing] = useState(false);
  const controllerRef = useRef<AbortController | null>(null);

  useEffect(() => () => controllerRef.current?.abort(), []);

  const poll = useCallback(async ({ background }: { background: boolean }) => {
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    setRefreshing(true);
    try {
      await reload(controller.signal, { background });
    } finally {
      // The flag belongs to the newest run: left set by a superseded one, the
      // control and every row action beside it stay disabled for good.
      if (controllerRef.current === controller) {
        controllerRef.current = null;
        setRefreshing(false);
      }
    }
  }, [reload]);

  const refresh = useCallback(() => poll({ background: false }), [poll]);

  return { poll, refresh, refreshing };
};
