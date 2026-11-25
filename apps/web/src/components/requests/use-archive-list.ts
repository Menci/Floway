import { useCallback, useEffect, useState } from 'react';

import { ARCHIVE_PAGE_SIZE, listArchives } from './archive';
import { usePollWhileVisible } from '../ui/use-poll-while-visible';
import { useRefresh } from '../ui/use-refresh';
import type { PipelineDumpMetadata } from '@floway-dev/gateway/browser';

interface History {
  scope: string;
  records: PipelineDumpMetadata[];
  hasOlder: boolean;
  error: string | null;
}

export const useArchiveList = (keyId: string | null, initial: PipelineDumpMetadata[], q: string, failures: boolean) => {
  const scope = JSON.stringify([keyId, q, failures]);
  const seed = { scope, records: initial, hasOlder: initial.length === ARCHIVE_PAGE_SIZE, error: null };
  const [history, setHistory] = useState<History>(seed);
  const current = history.scope === scope ? history : seed;
  if (history.scope !== scope) setHistory(seed);

  const apply = useCallback((update: (history: History) => History) => {
    setHistory(history => history.scope === scope ? update(history) : history);
  }, [scope]);

  const pageDepth = Math.max(1, Math.ceil(current.records.length / ARCHIVE_PAGE_SIZE));
  const refresh = useRefresh(useCallback(async (signal, { background }) => {
    if (keyId === null) return;
    const records: PipelineDumpMetadata[] = [];
    let hasOlder = false;
    for (let page = 0; page < pageDepth; page++) {
      const result = await listArchives(keyId, q, failures, signal, records.at(-1)?.id);
      if (signal.aborted) return;
      if (result.error) {
        if (!background) apply(history => ({ ...history, error: result.error.message }));
        return;
      }
      records.push(...result.data.records);
      hasOlder = result.data.records.length === ARCHIVE_PAGE_SIZE;
      if (!hasOlder) break;
    }
    apply(history => ({ ...history, records, hasOlder, error: background ? history.error : null }));
  }, [apply, failures, keyId, pageDepth, q]));

  const before = current.records.at(-1)?.id;
  const older = useRefresh(useCallback(async signal => {
    if (keyId === null || before === undefined || !current.hasOlder) return;
    const result = await listArchives(keyId, q, failures, signal, before);
    if (signal.aborted) return;
    if (result.error) {
      apply(history => ({ ...history, error: result.error.message }));
      return;
    }
    const page = result.data.records;
    apply(history => history.records.at(-1)?.id === before ? {
      ...history,
      records: [...history.records, ...page],
      hasOlder: page.length === ARCHIVE_PAGE_SIZE,
      error: null,
    } : history);
  }, [apply, before, current.hasOlder, failures, keyId, q]));

  const { cancel: cancelRefresh, poll } = refresh;
  const { cancel: cancelOlder, refresh: fetchOlder, refreshing } = older;
  useEffect(() => () => { cancelRefresh(); cancelOlder(); }, [cancelOlder, cancelRefresh, scope]);
  usePollWhileVisible(poll, undefined, keyId !== null && !refreshing);

  const loadOlder = async (): Promise<void> => {
    if (refreshing) return;
    cancelRefresh();
    await fetchOlder();
  };

  return { ...current, loadOlder, dismissError: () => { apply(history => ({ ...history, error: null })); } };
};
