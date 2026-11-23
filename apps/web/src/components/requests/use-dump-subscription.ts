import { useCallback, useEffect, useRef, useState } from 'react';

import { getCurrentSession } from '../../api/auth';
import { api, callApi } from '../../api/client';
import { getSessionToken } from '../../auth/session';
import { useTranslation } from '../../i18n/translation';
import { errorMessage } from '../../lib/error-message';
import type { DumpLiveSummary, DumpMetadata } from '@floway-dev/gateway/browser';

const PAGE_LIMIT = 100;

export type RequestListItem =
  | ({ readonly live: true } & DumpLiveSummary)
  | ({ readonly live?: false } & DumpMetadata);

export interface DumpSubscription {
  records: RequestListItem[];
  hasOlder: boolean;
  error: string | null;
  dismissError: () => void;
  loadOlder: () => Promise<void>;
}

export const useDumpSubscription = (keyId: string | null, initialRecords: RequestListItem[], q = '', failures = false): DumpSubscription => {
  const { t } = useTranslation();
  const [records, setRecords] = useState(initialRecords);
  const [hasOlder, setHasOlder] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Switching keys re-renders this hook rather than unmounting it, so an
  // older-page request outlives the key it was issued for; its whole outcome
  // -- rows, `setError` and `setHasOlder` alike -- is dropped when the
  // generation it was issued in is gone.
  const generationRef = useRef(0);
  // Generation-keyed rather than a boolean, so a request left behind by another
  // key cannot hold the new key's pagination shut.
  const loadingOlderRef = useRef<number | null>(null);
  const olderRequestRef = useRef<AbortController | null>(null);

  // react-i18next hands back a new `t` on every language change, and
  // LanguageSync announces one at boot whether or not the language it
  // lands on is the one i18next booted in, so the disconnect message reaches
  // the effect the same way the seed does.
  const disconnectedRef = useRef('');
  // eslint-disable-next-line react-hooks/refs -- Carrying the newest render's translation to an effect that must not list it as a dependency.
  disconnectedRef.current = t('requests.streamDisconnected');

  // Discarding during render rather than in the effect keeps the component from
  // ever painting one key's records under another key's heading.
  const scope = JSON.stringify([keyId, q, failures]);
  const [subscribedKeyId, setSubscribedKeyId] = useState(scope);
  if (subscribedKeyId !== scope) {
    setSubscribedKeyId(scope);
    setRecords(initialRecords);
    setError(null);
    setHasOlder(true);
    // eslint-disable-next-line react-hooks/refs -- The generation is part of the same discard: it is what tells a page still in flight that the list it was meant for is gone.
    generationRef.current += 1;
  }

  useEffect(() => {
    if (!keyId) return;

    const token = getSessionToken();
    if (!token) throw new Error('Authenticated dump subscription has no session token');
    const source = new EventSource(`/api/dump/keys/${encodeURIComponent(keyId)}/stream?session=${encodeURIComponent(token)}&q=${encodeURIComponent(q)}&failures=${failures}`);

    source.addEventListener('snapshot', raw => {
      const snapshot = (JSON.parse((raw as MessageEvent).data) as { records: DumpMetadata[] }).records;
      setRecords(current => {
        const ids = new Set(snapshot.map(record => record.id));
        const oldest = snapshot.at(-1)?.id;
        const inFlight = current.filter((record): record is Extract<RequestListItem, { live: true }> => record.live === true && !ids.has(record.id));
        const tail = oldest ? current.filter((record): record is DumpMetadata => record.live !== true && !ids.has(record.id) && record.id < oldest) : [];
        return [...inFlight, ...snapshot, ...tail];
      });
      setError(null);
    });
    source.addEventListener('started', raw => {
      const summary = JSON.parse((raw as MessageEvent).data) as DumpLiveSummary;
      setRecords(current => current.some(item => item.id === summary.id) ? current : [{ ...summary, live: true }, ...current]);
    });
    source.addEventListener('appended', raw => {
      const record = JSON.parse((raw as MessageEvent).data) as DumpMetadata;
      setRecords(current => {
        const existing = current.find(item => item.id === record.id);
        if (existing === undefined) return [record, ...current];
        if (existing.live !== true) return current;
        return current.map(item => item.id === record.id ? record : item);
      });
    });
    source.addEventListener('error', raw => {
      const data = (raw as MessageEvent).data as unknown;
      if (typeof data === 'string' && data) {
        try {
          setError((JSON.parse(data) as { message: string }).message);
        } catch {
          setError(data);
        }
        source.close();
      } else if (source.readyState === EventSource.CLOSED) {
        setError(disconnectedRef.current);
        // EventSource reports no status, and the stream carries the same session
        // as every other call; asking for the session puts an expired one
        // through authFetch, which is where "a 401 ends this session" lives.
        void getCurrentSession();
      }
    });
    return () => {
      olderRequestRef.current?.abort();
      source.close();
    };
  }, [keyId, q, failures]);

  const loadOlder = useCallback(async () => {
    const oldest = records.findLast((record): record is DumpMetadata => record.live !== true);
    const generation = generationRef.current;
    if (!keyId || !oldest || loadingOlderRef.current === generation || !hasOlder) return;
    loadingOlderRef.current = generation;
    const request = new AbortController();
    olderRequestRef.current = request;
    try {
      const result = await callApi(() => api.api.dump.keys[':keyId'].records.$get({
        param: { keyId },
        query: { before: oldest.id, limit: String(PAGE_LIMIT), q, failures: failures ? 'true' : 'false' },
      }, { init: { signal: request.signal } }));
      if (generation !== generationRef.current) return;
      if (result.error) {
        setError(result.error.message);
        return;
      }
      const page = result.data.records;
      if (page.length < PAGE_LIMIT) setHasOlder(false);
      if (page.length) setRecords(current => {
        const pageById = new Map(page.map(record => [record.id, record]));
        const withCompleted = current.map(record => {
          const completed = pageById.get(record.id);
          pageById.delete(record.id);
          return record.live === true && completed !== undefined ? completed : record;
        });
        return [...withCompleted, ...pageById.values()];
      });
    } catch (error) {
      if (generation !== generationRef.current) return;
      setError(errorMessage(error));
    } finally {
      if (loadingOlderRef.current === generation) loadingOlderRef.current = null;
    }
  }, [failures, hasOlder, keyId, q, records]);

  const dismissError = useCallback(() => setError(null), []);

  return { records, hasOlder, error, dismissError, loadOlder };
};
