import { useCallback, useEffect, useRef, useState } from 'react';

// The one guard a repeatable reload gets. A refresh control can be pressed
// twice, and every list route also reloads after a create, an edit or a
// delete, so two reloads overlap and the older one lands last -- a key just
// deleted comes back, a pair of independent fetches is shown torn across two
// round trips. Aborting rather than ignoring is what makes this a guard and
// not a filter: the superseded request stops at the transport instead of
// running to completion against a gateway that is already struggling.
//
// `reload` receives the signal and threads it into its calls
// (`$get(query, { init: { signal } })`); after awaiting it must return without
// writing state if the signal aborted. Unmounting aborts too.
export const useRefresh = (reload: (signal: AbortSignal) => Promise<void>) => {
  const [refreshing, setRefreshing] = useState(false);
  const controllerRef = useRef<AbortController | null>(null);

  useEffect(() => () => controllerRef.current?.abort(), []);

  const refresh = useCallback(async () => {
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    setRefreshing(true);
    try {
      await reload(controller.signal);
    } finally {
      // The flag belongs to the newest run. Left set by a superseded one, the
      // control and every row action beside it stay disabled until the page is
      // navigated away from.
      if (controllerRef.current === controller) {
        controllerRef.current = null;
        setRefreshing(false);
      }
    }
  }, [reload]);

  return { refresh, refreshing };
};
