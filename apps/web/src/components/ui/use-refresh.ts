import { useCallback, useEffect, useRef, useState } from 'react';

// `reload` must thread the signal into its calls and, after awaiting, return
// without writing state if it aborted. It also receives whether anybody asked
// for the run: a background run must not clear a failure nobody has read yet.
export interface RefreshControl {
  refresh: () => Promise<void>;
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

const sameQuery = <Query extends Record<string, unknown>>(left: Query, right: Query): boolean =>
  Object.keys(left).every(key => left[key] === right[key]);

/**
 * A page whose data is a function of a query refetches whenever the query
 * changes. `reload` reports the moment the answer lands by calling `arrived`,
 * and that is where the query the data on screen came back for is recorded. A
 * "have I mounted yet" flag instead would make StrictMode's double invocation
 * indistinguishable from a real change and refetch on every visit; recording
 * the query at request time instead would strand a run torn down before it
 * answered.
 *
 * `query` also carries the identity every run and the poll interval hang from,
 * so the caller holds it across the renders in which its fields do not change.
 */
export const useRefreshOnChange = <Query extends Record<string, unknown>>(
  query: Query,
  reload: (signal: AbortSignal, options: { background: boolean }, arrived: () => void) => Promise<void>,
): RefreshControl => {
  const loadedFor = useRef(query);
  const control = useRefresh(useCallback(
    (signal: AbortSignal, options: { background: boolean }) => reload(signal, options, () => { loadedFor.current = query; }),
    [query, reload],
  ));
  const { refresh } = control;

  useEffect(() => {
    if (sameQuery(loadedFor.current, query)) return;
    void refresh();
  }, [query, refresh]);

  return control;
};
