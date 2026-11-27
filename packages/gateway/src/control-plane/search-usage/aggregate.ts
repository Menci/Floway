// The repo stores one row per (backend, keyId, action, hour). The two
// aggregators below collapse the action dimension, summing search and
// fetch_page into a single `requests` count per (backend, keyId, hour) or
// (backend, userId, hour).

import type { WebSearchUsageRecord } from '../../repo/types.ts';
import type { WebSearchBackendName } from '../../shared/web-search-backends.ts';

export interface DisplayWebSearchUsageByKeyRecord {
  backend: WebSearchBackendName;
  keyId: string;
  hour: string;
  requests: number;
}

export interface DisplayWebSearchUsageByUserRecord {
  backend: WebSearchBackendName;
  userId: number;
  hour: string;
  requests: number;
}

export const aggregateWebSearchUsageByKey = (records: readonly WebSearchUsageRecord[]): DisplayWebSearchUsageByKeyRecord[] => {
  const grouped = new Map<string, DisplayWebSearchUsageByKeyRecord>();
  for (const r of records) {
    const key = JSON.stringify([r.backend, r.keyId, r.hour]);
    const existing = grouped.get(key);
    if (existing) {
      existing.requests += r.requests;
    } else {
      grouped.set(key, { backend: r.backend, keyId: r.keyId, hour: r.hour, requests: r.requests });
    }
  }
  return [...grouped.values()].sort((a, b) => a.hour.localeCompare(b.hour) || a.keyId.localeCompare(b.keyId) || a.backend.localeCompare(b.backend));
};

// Records whose keyId no longer resolves to a user (a key the operator hard-
// deleted directly in the DB) collapse into a synthetic userId 0 so the
// dashboard can still surface the lost rows; the keyToUser map is populated
// from active + soft-deleted api_keys, so a normal soft delete still resolves.
export const aggregateWebSearchUsageByUser = (
  records: readonly WebSearchUsageRecord[],
  keyToUser: ReadonlyMap<string, number>,
): DisplayWebSearchUsageByUserRecord[] => {
  const grouped = new Map<string, DisplayWebSearchUsageByUserRecord>();
  for (const r of records) {
    const userId = keyToUser.get(r.keyId) ?? 0;
    const key = JSON.stringify([r.backend, userId, r.hour]);
    const existing = grouped.get(key);
    if (existing) {
      existing.requests += r.requests;
    } else {
      grouped.set(key, { backend: r.backend, userId, hour: r.hour, requests: r.requests });
    }
  }
  return [...grouped.values()].sort((a, b) => a.hour.localeCompare(b.hour) || a.userId - b.userId || a.backend.localeCompare(b.backend));
};
