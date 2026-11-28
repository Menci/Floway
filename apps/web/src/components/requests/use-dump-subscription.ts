import { useCallback, useEffect, useRef, useState } from 'react';

import { getCurrentSession } from '../../api/auth';
import { api, callApi } from '../../api/client';
import { getSessionToken } from '../../auth/session';
import { useTranslation } from '../../i18n/translation';
import { errorMessage } from '../../lib/error-message';
import type { DumpMetadata } from '@floway-dev/gateway/browser';

const PAGE_LIMIT = 100;

// Which log the panel is showing: one key's, or every dump-enabled key's
// merged newest-first stream. `keyIds` is content, not identity: a changed set
// reopens the stream because the server derives its subscriptions from the
// keys the account owns at connect time.
export interface DumpScope {
  keyId: string | null;
  keyIds: readonly string[];
}

export interface DumpSubscription {
  records: DumpMetadata[];
  hasOlder: boolean;
  error: string | null;
  dismissError: () => void;
  loadOlder: () => Promise<void>;
}

export const useDumpSubscription = (
  scope: DumpScope,
  initialRecords: DumpMetadata[],
  q = '',
  failures = false,
): DumpSubscription => {
  const { t } = useTranslation();
  const [records, setRecords] = useState(initialRecords);
  const [hasOlder, setHasOlder] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const seenRef = useRef(new Set<string>());
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

  const keyId = scope.keyId;
  const allKeyIds = keyId === null ? scope.keyIds : [];
  // Filters belong to the scope too: switching them must discard the previous
  // page during render, not paint old rows under the new filter until the
  // reconnect's snapshot lands.
  const scopeToken = JSON.stringify([keyId, allKeyIds, q, failures]);
  // Discarding during render rather than in the effect keeps the component from
  // ever painting one key's records under another key's heading.
  const [subscribedScope, setSubscribedScope] = useState(scopeToken);
  if (subscribedScope !== scopeToken) {
    setSubscribedScope(scopeToken);
    setRecords(initialRecords);
    setError(null);
    setHasOlder(true);
    // eslint-disable-next-line react-hooks/refs -- The generation is part of the same discard: it is what tells a page still in flight that the list it was meant for is gone.
    generationRef.current += 1;
  }

  const allKeyIdsToken = JSON.stringify(allKeyIds);
  useEffect(() => {
    seenRef.current = new Set(initialRecordsRef.current.map(record => record.id));
    if (keyId === null && allKeyIdsToken === '[]') return;

    const token = getSessionToken();
    if (!token) throw new Error('Authenticated dump subscription has no session token');
    const query = `?session=${encodeURIComponent(token)}&q=${encodeURIComponent(q)}&failures=${failures}`;
    const source = new EventSource(keyId === null
      ? `/api/dump/stream${query}`
      : `/api/dump/keys/${encodeURIComponent(keyId)}/stream${query}`);

    source.addEventListener('snapshot', raw => {
      const snapshot = (JSON.parse((raw as MessageEvent).data) as { records: DumpMetadata[] }).records;
      setRecords(current => {
        const ids = new Set(snapshot.map(record => record.id));
        const oldest = snapshot.at(-1)?.id;
        const tail = oldest ? current.filter(record => !ids.has(record.id) && record.id < oldest) : [];
        const next = [...snapshot, ...tail];
        seenRef.current = new Set(next.map(record => record.id));
        return next;
      });
      setError(null);
    });
    source.addEventListener('appended', raw => {
      const record = JSON.parse((raw as MessageEvent).data) as DumpMetadata;
      if (seenRef.current.has(record.id)) return;
      seenRef.current.add(record.id);
      setRecords(current => [record, ...current]);
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
  }, [allKeyIdsToken, failures, keyId, q]);

  const loadOlder = useCallback(async () => {
    const oldest = records.at(-1);
    const generation = generationRef.current;
    if (keyId === null && allKeyIdsToken === '[]') return;
    if (!oldest || loadingOlderRef.current === generation || !hasOlder) return;
    loadingOlderRef.current = generation;
    const request = new AbortController();
    olderRequestRef.current = request;
    try {
      const result = keyId === null
        ? await callApi(() => api.api.dump.records.$get({
            query: { before: oldest.id, limit: String(PAGE_LIMIT), q, failures: failures ? 'true' : 'false' },
          }, { init: { signal: request.signal } }))
        : await callApi(() => api.api.dump.keys[':keyId'].records.$get({
            param: { keyId },
            query: { before: oldest.id, limit: String(PAGE_LIMIT), q, failures: failures ? 'true' : 'false' },
          }, { init: { signal: request.signal } }));
      if (generation !== generationRef.current) return;
      if (result.error) {
        setError(result.error.message);
        return;
      }
      const page = result.data.records;
      const fresh = page.filter(record => !seenRef.current.has(record.id));
      fresh.forEach(record => seenRef.current.add(record.id));
      if (page.length < PAGE_LIMIT) setHasOlder(false);
      if (fresh.length) setRecords(current => [...current, ...fresh]);
    } catch (error) {
      if (generation !== generationRef.current) return;
      setError(errorMessage(error));
    } finally {
      if (loadingOlderRef.current === generation) loadingOlderRef.current = null;
    }
  }, [allKeyIdsToken, failures, hasOlder, keyId, q, records]);

  const dismissError = useCallback(() => setError(null), []);

  return { records, hasOlder, error, dismissError, loadOlder };
};
