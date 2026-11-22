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
  const completedIdsRef = useRef(new Set<string>());
  const liveIdsRef = useRef(new Set<string>());
  // Switching keys re-renders this hook rather than unmounting it, so an
  // older-page request outlives the key it was issued for; its whole outcome
  // -- rows, `setError` and `setHasOlder` alike -- is dropped when the
  // generation it was issued in is gone.
  const generationRef = useRef(0);
  // Generation-keyed rather than a boolean, so a request left behind by another
  // key cannot hold the new key's pagination shut.
  const loadingOlderRef = useRef<number | null>(null);
  const olderRequestRef = useRef<AbortController | null>(null);

  // The loader hands back a fresh `initialRecords` array on every run and
  // selecting a record re-runs the loader, so the seed reaches the effect
  // through a ref; listing it as a dependency would close the stream and pay
  // for another server snapshot on every selection.
  const initialRecordsRef = useRef(initialRecords);
  // eslint-disable-next-line react-hooks/refs -- Carrying the newest render's seed to an effect that must not list it as a dependency.
  initialRecordsRef.current = initialRecords;

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
    // eslint-disable-next-line react-hooks/refs -- The new key starts with no known live or completed ids, before its stream can replay them.
    completedIdsRef.current = new Set();
    // eslint-disable-next-line react-hooks/refs -- The new key starts with no known live or completed ids, before its stream can replay them.
    liveIdsRef.current = new Set();
    // eslint-disable-next-line react-hooks/refs -- The generation is part of the same discard: it is what tells a page still in flight that the list it was meant for is gone.
    generationRef.current += 1;
  }

  useEffect(() => {
    completedIdsRef.current = new Set(initialRecordsRef.current.filter(record => record.live !== true).map(record => record.id));
    liveIdsRef.current = new Set(initialRecordsRef.current.filter(record => record.live === true).map(record => record.id));
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
        const next = [...inFlight, ...snapshot, ...tail];
        completedIdsRef.current = new Set(snapshot.map(record => record.id));
        for (const record of tail) completedIdsRef.current.add(record.id);
        liveIdsRef.current = new Set(inFlight.map(record => record.id));
        return next;
      });
      setError(null);
    });
    source.addEventListener('started', raw => {
      const summary = JSON.parse((raw as MessageEvent).data) as DumpLiveSummary;
      if (completedIdsRef.current.has(summary.id) || liveIdsRef.current.has(summary.id)) return;
      liveIdsRef.current.add(summary.id);
      setRecords(current => [{ ...summary, live: true }, ...current]);
    });
    source.addEventListener('appended', raw => {
      const record = JSON.parse((raw as MessageEvent).data) as DumpMetadata;
      if (completedIdsRef.current.has(record.id)) return;
      completedIdsRef.current.add(record.id);
      liveIdsRef.current.delete(record.id);
      setRecords(current => current.some(item => item.id === record.id)
        ? current.map(item => item.id === record.id ? record : item)
        : [record, ...current]);
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
    const oldest = [...records].reverse().find((record): record is DumpMetadata => record.live !== true);
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
      const fresh = page.filter(record => !completedIdsRef.current.has(record.id));
      fresh.forEach(record => completedIdsRef.current.add(record.id));
      if (page.length < PAGE_LIMIT) setHasOlder(false);
      if (fresh.length) setRecords(current => [...current, ...fresh]);
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
