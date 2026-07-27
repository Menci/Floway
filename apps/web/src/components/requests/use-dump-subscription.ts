import { useCallback, useEffect, useRef, useState } from "react";
import type { DumpMetadata } from "@floway-dev/gateway/dump-types";

import { authFetch } from "../../api/auth";
import { getSessionToken } from "../../auth/session";

const PAGE_LIMIT = 100;

export function useDumpSubscription(keyId: string | null) {
  const [records, setRecords] = useState<DumpMetadata[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [hasOlder, setHasOlder] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const seenRef = useRef(new Set<string>());
  const loadingOlderRef = useRef(false);

  useEffect(() => {
    setRecords([]);
    seenRef.current.clear();
    setError(null);
    setHasOlder(true);
    loadingOlderRef.current = false;
    if (!keyId) {
      setLoading(false);
      return;
    }

    const token = getSessionToken();
    if (!token) return;
    setLoading(true);
    const source = new EventSource(`/api/dump/keys/${encodeURIComponent(keyId)}/stream?session=${encodeURIComponent(token)}`);

    source.addEventListener("snapshot", (raw) => {
      const snapshot = (JSON.parse((raw as MessageEvent).data) as { records: DumpMetadata[] }).records;
      setRecords((current) => {
        const ids = new Set(snapshot.map((record) => record.id));
        const oldest = snapshot.at(-1)?.id;
        const tail = oldest ? current.filter((record) => !ids.has(record.id) && record.id < oldest) : [];
        const next = [...snapshot, ...tail];
        seenRef.current = new Set(next.map((record) => record.id));
        return next;
      });
      setLoading(false);
      setError(null);
    });
    source.addEventListener("appended", (raw) => {
      const record = JSON.parse((raw as MessageEvent).data) as DumpMetadata;
      if (seenRef.current.has(record.id)) return;
      seenRef.current.add(record.id);
      setRecords((current) => [record, ...current]);
    });
    source.addEventListener("error", (raw) => {
      const data = (raw as MessageEvent).data as unknown;
      if (typeof data === "string" && data) {
        try {
          setError((JSON.parse(data) as { message: string }).message);
        } catch {
          setError(data);
        }
        setLoading(false);
        source.close();
      } else if (source.readyState === EventSource.CLOSED) {
        setError("Stream disconnected");
        setLoading(false);
      }
    });
    return () => source.close();
  }, [keyId]);

  const loadOlder = useCallback(async () => {
    const oldest = records.at(-1);
    if (!keyId || !oldest || loadingOlderRef.current || !hasOlder) return;
    loadingOlderRef.current = true;
    setLoadingOlder(true);
    try {
      const response = await authFetch(
        `/api/dump/keys/${encodeURIComponent(keyId)}/records?before=${encodeURIComponent(oldest.id)}&limit=${PAGE_LIMIT}`,
      );
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const page = (await response.json() as { records: DumpMetadata[] }).records;
      const fresh = page.filter((record) => !seenRef.current.has(record.id));
      fresh.forEach((record) => seenRef.current.add(record.id));
      if (page.length < PAGE_LIMIT) setHasOlder(false);
      if (fresh.length) setRecords((current) => [...current, ...fresh]);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      loadingOlderRef.current = false;
      setLoadingOlder(false);
    }
  }, [hasOlder, keyId, records]);

  return { records, loading, loadingOlder, hasOlder, error, loadOlder };
}
