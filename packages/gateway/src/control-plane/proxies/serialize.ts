// Wire-format projection for proxies and their backoff state. Proxy URLs are
// returned verbatim — the URI itself carries the secret material (password /
// shadowsocks key) that callers need to round-trip when re-editing a row.
// Backoffs carry current upstream identity so operator surfaces never have to
// present a storage id or join a separately fetched catalog snapshot.

import type { BackoffRow, ProxyRecord } from '../../repo/types.ts';
import type { UpstreamRecord } from '@floway-dev/provider';

export interface SerializedProxyRecord {
  id: string;
  name: string;
  url: string;
  created_at: string;
  updated_at: string;
  dial_timeout_seconds: number | null;
}

export interface SerializedBackoffRow {
  proxy_id: string;
  upstream_id: string;
  upstream: Pick<UpstreamRecord, 'id' | 'name' | 'kind' | 'hue'>;
  fail_count: number;
  expires_at: number;
  last_error: string | null;
  last_error_at: number | null;
}

export const proxyRecordToJson = (record: ProxyRecord): SerializedProxyRecord => ({
  id: record.id,
  name: record.name,
  url: record.url,
  created_at: record.createdAt,
  updated_at: record.updatedAt,
  dial_timeout_seconds: record.dialTimeoutSeconds,
});

export const backoffRowToJson = (
  row: BackoffRow,
  upstream: Pick<UpstreamRecord, 'id' | 'name' | 'kind' | 'hue'>,
): SerializedBackoffRow => ({
  proxy_id: row.proxyId,
  upstream_id: row.upstreamId,
  upstream: {
    id: upstream.id,
    name: upstream.name,
    kind: upstream.kind,
    hue: upstream.hue,
  },
  fail_count: row.failCount,
  expires_at: row.expiresAt,
  last_error: row.lastError,
  last_error_at: row.lastErrorAt,
});

export const backoffRowsToJson = (
  rows: readonly BackoffRow[],
  upstreams: readonly Pick<UpstreamRecord, 'id' | 'name' | 'kind' | 'hue'>[],
): SerializedBackoffRow[] => {
  const upstreamById = new Map(upstreams.map(upstream => [upstream.id, upstream]));
  // A row can outlive its upstream when an older build recorded a draft probe
  // under the synthetic 'draft' id, or when a delete races an in-flight dial.
  // Such a row is invisible to the dial layer too (it can never be matched to
  // a saved upstream), so it carries no state an operator can act on. Dropping
  // it here keeps one orphan from taking down the whole backoff listing.
  return rows.flatMap(row => {
    const upstream = upstreamById.get(row.upstreamId);
    return upstream === undefined ? [] : [backoffRowToJson(row, upstream)];
  });
};
