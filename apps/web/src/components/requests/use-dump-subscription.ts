import { useCallback, useEffect, useRef, useState } from 'react';

import { api, callApi } from '../../api/client';
import { getSessionToken } from '../../auth/session';
import { errorMessage } from '../../lib/error-message';
import type { DumpMetadata } from '@floway-dev/gateway/dump-types';

const PAGE_LIMIT = 100;

export interface DumpSubscription {
  records: DumpMetadata[];
  hasOlder: boolean;
  error: string | null;
  dismissError: () => void;
  loadOlder: () => Promise<void>;
}

export const useDumpSubscription = (keyId: string | null, initialRecords: DumpMetadata[]): DumpSubscription => {
  const [records, setRecords] = useState(initialRecords);
  const [hasOlder, setHasOlder] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const seenRef = useRef(new Set<string>());
  // Which key's accumulation the hook holds. An older-page request outlives
  // the key it was issued for, because switching keys re-renders this hook
  // rather than unmounting it, so the page it brings back is answered against
  // the generation it was issued in and a page from an earlier one is dropped
  // whole -- not merely its rows: `setError` and `setHasOlder` would carry one
  // key's outcome into another key's list just as wrongly, and a `hasOlder`
  // turned off by the wrong key's short page ends the new key's pagination for
  // as long as the route stays open.
  const generationRef = useRef(0);
  // The generation of the request in flight, or null when none is. Asked this
  // way, a request left behind by another key cannot hold the new key's
  // pagination shut, and the request that ends releases only its own claim.
  const loadingOlderRef = useRef<number | null>(null);
  const olderRequestRef = useRef<AbortController | null>(null);

  // The loader hands back a fresh `initialRecords` array on every run, and
  // selecting a record re-runs the loader. The subscription is keyed on the API
  // key alone, so the seed reaches the effect through a ref rather than through
  // its deps; otherwise every selection would close the stream and pay for
  // another server snapshot. The ref is written here, beside the state the
  // same input adjusts during render, and is read only from the effect.
  const initialRecordsRef = useRef(initialRecords);
  // eslint-disable-next-line react-hooks/refs -- Carrying the newest render's seed to an effect that must not list it as a dependency.
  initialRecordsRef.current = initialRecords;

  // Switching keys discards the previous stream's accumulation. Doing that
  // during render rather than in the effect means the component never paints
  // one key's records under another key's heading.
  const [subscribedKeyId, setSubscribedKeyId] = useState(keyId);
  if (subscribedKeyId !== keyId) {
    setSubscribedKeyId(keyId);
    setRecords(initialRecords);
    setError(null);
    setHasOlder(true);
    // eslint-disable-next-line react-hooks/refs -- The generation is part of the same discard: it is what tells a page still in flight that the list it was meant for is gone.
    generationRef.current += 1;
  }

  useEffect(() => {
    seenRef.current = new Set(initialRecordsRef.current.map(record => record.id));
    if (!keyId) return;

    const token = getSessionToken();
    if (!token) throw new Error('Authenticated dump subscription has no session token');
    const source = new EventSource(`/api/dump/keys/${encodeURIComponent(keyId)}/stream?session=${encodeURIComponent(token)}`);

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
        setError('Stream disconnected');
      }
    });
    return () => {
      // The page still in flight belongs to the subscription being closed, so
      // it goes with it. Its result would be discarded either way; aborting
      // spares the round trip.
      olderRequestRef.current?.abort();
      source.close();
    };
  }, [keyId]);

  const loadOlder = useCallback(async () => {
    const oldest = records.at(-1);
    const generation = generationRef.current;
    if (!keyId || !oldest || loadingOlderRef.current === generation || !hasOlder) return;
    loadingOlderRef.current = generation;
    const request = new AbortController();
    olderRequestRef.current = request;
    try {
      const result = await callApi(() => api.api.dump.keys[':keyId'].records.$get({
        param: { keyId },
        query: { before: oldest.id, limit: String(PAGE_LIMIT) },
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
  }, [hasOlder, keyId, records]);

  const dismissError = useCallback(() => setError(null), []);

  return { records, hasOlder, error, dismissError, loadOlder };
};
