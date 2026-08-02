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
//
// It also receives whether anybody asked for the run. A page that polls itself
// reloads on a timer, and a run nobody asked for must not clear a failure
// nobody has read yet -- so `background` is what such a reload consults before
// wiping its own error state. It rides beside the signal rather than in front
// of it so a reload with no such state ignores it and keeps its one-parameter
// shape.
export interface RefreshControl {
  /** The control's own press: somebody asked, so the run is a foreground one. */
  refresh: () => Promise<void>;
  /**
   * The same run, told who asked for it. This is what a self-polling page
   * drives -- see ./use-poll-while-visible.ts, which decides the flag per tick
   * -- so such a page states its reload once here instead of writing a second
   * copy of the abort, the supersede and the flag around it.
   */
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
      // The flag belongs to the newest run. Left set by a superseded one, the
      // control and every row action beside it stay disabled until the page is
      // navigated away from.
      if (controllerRef.current === controller) {
        controllerRef.current = null;
        setRefreshing(false);
      }
    }
  }, [reload]);

  const refresh = useCallback(() => poll({ background: false }), [poll]);

  return { poll, refresh, refreshing };
};
