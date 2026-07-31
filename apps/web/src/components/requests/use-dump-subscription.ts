import { useCallback, useEffect, useRef, useState } from 'react';

import { api, callApi } from '../../api/client';
import { getSessionToken } from '../../auth/session';
import { errorMessage } from '../../lib/error-message';
import type { DumpMetadata } from '@floway-dev/gateway/dump-types';

const PAGE_LIMIT = 100;

export function useDumpSubscription(keyId: string | null, initialRecords: DumpMetadata[]) {
  const [records, setRecords] = useState(initialRecords);
  const [hasOlder, setHasOlder] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const seenRef = useRef(new Set<string>());
  const loadingOlderRef = useRef(false);

  // Switching keys discards the previous stream's accumulation. Doing that
  // during render rather than in the effect means the component never paints
  // one key's records under another key's heading.
  const [subscribedKeyId, setSubscribedKeyId] = useState(keyId);
  if (subscribedKeyId !== keyId) {
    setSubscribedKeyId(keyId);
    setRecords(initialRecords);
    setError(null);
    setHasOlder(true);
  }

  useEffect(() => {
    seenRef.current = new Set(initialRecords.map(record => record.id));
    loadingOlderRef.current = false;
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
    return () => source.close();
  }, [initialRecords, keyId]);

  const loadOlder = useCallback(async () => {
    const oldest = records.at(-1);
    if (!keyId || !oldest || loadingOlderRef.current || !hasOlder) return;
    loadingOlderRef.current = true;
    try {
      const result = await callApi(() => api.api.dump.keys[':keyId'].records.$get({
        param: { keyId },
        query: { before: oldest.id, limit: String(PAGE_LIMIT) },
      }));
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
      setError(errorMessage(error));
    } finally {
      loadingOlderRef.current = false;
    }
  }, [hasOlder, keyId, records]);

  const dismissError = useCallback(() => setError(null), []);

  return { records, hasOlder, error, dismissError, loadOlder };
}
