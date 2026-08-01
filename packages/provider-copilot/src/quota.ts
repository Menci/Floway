// Copilot entitlement state has two sources, and they agree field for field:
//
//   1. `x-quota-snapshot-<quota_id>` response headers, set by the Copilot data
//      plane on every successful `/chat/completions`, `/responses`, and
//      `/v1/messages` call — streaming included, where they arrive ahead of the
//      first SSE byte. This is the passive source: it costs nothing and tracks
//      consumption from every client sharing the seat, not just ours.
//   2. `GET https://api.github.com/copilot_internal/user`, the operator-driven
//      refresh. This is the only source for an upstream that has not served a
//      request yet.
//
// Both project into `CopilotQuotaSnapshot` so the dashboard renders one shape
// regardless of which path filled the slot. Field names follow the REST
// vocabulary because that is the upstream's own naming; the headers are an
// abbreviation of it.
//
// Header set captured from a live enterprise seat on 2026-08-01:
//
//   x-quota-snapshot-chat: ent=-1&ov=0.0&ovPerm=false&rem=100.0&rst=2026-09-01T00%3A00%3A00Z&totRem=-1
//   x-quota-snapshot-completions: ent=-1&ov=0.0&ovPerm=false&rem=100.0&rst=2026-09-01T00%3A00%3A00Z&totRem=-1
//   x-quota-snapshot-premium_interactions: ent=10000000&ov=0.0&ovPerm=true&rem=97.1&rst=2026-09-01T00%3A00%3A00Z&totRem=9719759.1
//
// The same grammar is documented by GitHub's own proxy sidecar
// (https://github.com/github/gh-aw-firewall/blob/e2753f92d37d1c1b7f62bde61ab929cf0798571b/containers/api-proxy/billing-headers.js)
// and consumed header-first — with `copilot_internal/user` as the fallback —
// by the shipping client
// (https://github.com/microsoft/vscode/blob/7234ef01c2cace7cfa911d792ce9c5b1f333fca5/extensions/copilot/src/platform/chat/common/chatQuotaServiceImpl.ts#L85-L153).

import { githubHeaders } from './auth.ts';
import { readCopilotUpstreamState, type CopilotUpstreamState } from './state.ts';
import { getProviderRepo, type Fetcher } from '@floway-dev/provider';

// One quota bucket. A seat reports three kinds of bucket and both sources spell
// them differently, so nothing but the pair below is safe to read:
//
//   metered      real cap, real consumption.
//   uncapped     `unlimited`. Headers spell it `ent=-1&totRem=-1`; the REST body
//                sets the flag with `entitlement: 0`, so neither number infers it.
//   unavailable  the bucket does not apply to this seat — a free seat's
//                `premium_interactions` comes back `entitlement: 0` with
//                `has_quota: false` and `percent_remaining: 0`. Reading that as
//                consumption renders "0 / 0 · 100% used" on a seat that simply
//                has no premium allotment.
//
// `entitlement > 0` separates metered from unavailable on both sources, which is
// why `has_quota` is not projected: the headers have no counterpart for it, so a
// consumer keying off it would work on one source and not the other.
export interface CopilotQuotaDetail {
  entitlement: number;
  overage_count: number;
  overage_permitted: boolean;
  percent_remaining: number;
  quota_remaining: number;
  unlimited: boolean;
}

export interface CopilotQuotaSnapshot {
  // Stamped by us. The headers carry no observation time, and the REST body's
  // `timestamp_utc` is per bucket rather than per snapshot.
  observed_at: string;
  // ISO 8601. The whole seat resets at one instant, so this is snapshot-level
  // even though the headers repeat it on every bucket.
  reset_at: string | null;
  // Keyed by Copilot's `quota_id`. `chat`, `completions`, and
  // `premium_interactions` are what a seat serves today, and `premium_models`
  // appears in the wild, so the id stays an open string: we keep whatever
  // buckets the upstream names rather than pinning a known set.
  quotas: Record<string, CopilotQuotaDetail>;
}

const QUOTA_SNAPSHOT_HEADER_PREFIX = 'x-quota-snapshot-';

const UNLIMITED_SENTINEL = -1;

const isUnsafeQuotaId = (id: string): boolean =>
  id === '' || id === '__proto__' || id === 'constructor' || id === 'prototype';

const parseNumber = (raw: string | null): number | null => {
  if (raw === null) return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
};

const finiteOrNull = (value: number | undefined): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

// Both sources hand us a reset instant as a string, and both can hand us an
// empty one — `rst=` with no value, or `quota_reset_date_utc: ""`. Rendering
// that produces "Invalid Date", so anything unparseable reads as "no reset
// instant reported".
const resetInstantOrNull = (raw: string | null | undefined): string | null => {
  if (raw === null || raw === undefined || raw.trim() === '') return null;
  return Number.isNaN(new Date(raw).getTime()) ? null : raw;
};

// `ent=-1&ov=0.0&ovPerm=false&rem=100.0&rst=...&totRem=-1`. A bucket is only
// accepted when every numeric field parses: a partial bucket would render as a
// confident zero on the dashboard, which is worse than showing nothing.
const parseQuotaDetail = (fields: URLSearchParams): CopilotQuotaDetail | null => {
  const entitlement = parseNumber(fields.get('ent'));
  const overageCount = parseNumber(fields.get('ov'));
  const percentRemaining = parseNumber(fields.get('rem'));
  const quotaRemaining = parseNumber(fields.get('totRem'));
  if (entitlement === null || overageCount === null || percentRemaining === null || quotaRemaining === null) {
    return null;
  }
  return {
    entitlement,
    overage_count: overageCount,
    overage_permitted: fields.get('ovPerm') === 'true',
    percent_remaining: percentRemaining,
    quota_remaining: quotaRemaining,
    unlimited: entitlement === UNLIMITED_SENTINEL,
  };
};

// Returns null when the response carries no quota headers at all — the shape of
// every 4xx we have observed, and of `/models`. Callers use that to leave a
// previously persisted snapshot untouched instead of erasing it.
export const parseCopilotQuotaHeaders = (headers: Headers, now: Date): CopilotQuotaSnapshot | null => {
  const quotas: Record<string, CopilotQuotaDetail> = {};
  let resetAt: string | null = null;

  headers.forEach((value, name) => {
    const lower = name.toLowerCase();
    if (!lower.startsWith(QUOTA_SNAPSHOT_HEADER_PREFIX)) return;
    const quotaId = lower.slice(QUOTA_SNAPSHOT_HEADER_PREFIX.length);
    if (isUnsafeQuotaId(quotaId)) return;
    const fields = new URLSearchParams(value);
    const detail = parseQuotaDetail(fields);
    if (detail === null) return;
    quotas[quotaId] = detail;
    resetAt ??= resetInstantOrNull(fields.get('rst'));
  });

  if (Object.keys(quotas).length === 0) return null;
  return { observed_at: now.toISOString(), reset_at: resetAt, quotas };
};

// `GET /copilot_internal/user`. Every field is optional: that is how GitHub's own
// Copilot CLI SDK types this endpoint (a zod schema in `@github/copilot`'s
// typings, `strip` mode so unknown keys pass through), and the captures agree.
// We declare only what we project — a field we do not read has no business
// being here.
//
// Two body shapes are live at once, split by GitHub's 2026-06-01 AI-Credits
// change. A seat on the current shape reports `quota_snapshots` whatever its
// plan, including free (captured 2026-07-08 on a `free_limited_copilot` seat:
// `chat` 200, `completions` 2000, `premium_interactions` entitlement 0 with
// `has_quota: false`). A seat on the legacy shape reports through
// `limited_user_quotas` (remaining) + `monthly_quotas` (entitlement) and leaves
// `quota_snapshots` empty or absent — we do not read those, so such a body
// projects to "nothing observed" and the header path is what fills the slot.
// Captured legacy and current bodies for the same free SKU:
// https://github.com/TopiCsarno/yapcap/blob/152ea67c3abd44776268627d58533003099da951/fixtures/copilot/copilot_user_response.json
// https://github.com/bugwz/AIMeter/blob/main/docs/providers/copliot/demo.free.json
export interface CopilotUsageResponse {
  quota_reset_date_utc?: string;
  quota_snapshots?: Record<string, {
    entitlement?: number;
    overage_count?: number;
    overage_permitted?: boolean;
    percent_remaining?: number;
    quota_remaining?: number;
    unlimited?: boolean;
  }>;
}

// The REST body holds the same three numbers the headers do, so it gets the same
// treatment: a bucket whose cap or remainder is missing or non-finite is dropped
// rather than rendered as a confident zero. `percent_remaining` is derived when
// the body omits it, because that is arithmetic on the two fields we require —
// not a default standing in for an unknown.
const projectQuotaDetail = (detail: {
  entitlement?: number;
  overage_count?: number;
  overage_permitted?: boolean;
  percent_remaining?: number;
  quota_remaining?: number;
  unlimited?: boolean;
}): CopilotQuotaDetail | null => {
  const entitlement = finiteOrNull(detail.entitlement);
  const quotaRemaining = finiteOrNull(detail.quota_remaining);
  if (entitlement === null || quotaRemaining === null) return null;
  const percentRemaining = finiteOrNull(detail.percent_remaining)
    ?? (entitlement > 0 ? (quotaRemaining / entitlement) * 100 : 0);
  return {
    entitlement,
    overage_count: finiteOrNull(detail.overage_count) ?? 0,
    overage_permitted: detail.overage_permitted === true,
    percent_remaining: percentRemaining,
    quota_remaining: quotaRemaining,
    unlimited: detail.unlimited === true || entitlement === UNLIMITED_SENTINEL,
  };
};

// Same null contract as `parseCopilotQuotaHeaders`: a body that reports no
// buckets is "nothing observed", not "everything is zero". Returning a
// well-formed empty snapshot here would let an operator's refresh overwrite a
// good reading the header path had already harvested.
export const projectCopilotUsageResponse = (body: CopilotUsageResponse, now: Date): CopilotQuotaSnapshot | null => {
  const quotas: Record<string, CopilotQuotaDetail> = {};
  for (const [quotaId, detail] of Object.entries(body.quota_snapshots ?? {})) {
    if (isUnsafeQuotaId(quotaId)) continue;
    const projected = projectQuotaDetail(detail);
    if (projected !== null) quotas[quotaId] = projected;
  }
  if (Object.keys(quotas).length === 0) return null;
  return {
    observed_at: now.toISOString(),
    reset_at: resetInstantOrNull(body.quota_reset_date_utc),
    quotas,
  };
};

export const fetchCopilotUsage = (githubToken: string, fetcher: Fetcher): Promise<Response> =>
  fetcher('https://api.github.com/copilot_internal/user', { headers: githubHeaders(githubToken) });

// Both sources land in the same slot, so whichever observed the seat most
// recently is what the dashboard shows. The CAS is keyed on the state we just
// read: losing it to a concurrent token mint or known-models save is expected
// under load, and the loser's snapshot is worth no more than the winner's.
export const putCopilotQuota = async (upstreamId: string, snapshot: CopilotQuotaSnapshot): Promise<void> => {
  const fresh = await getProviderRepo().upstreams.getById(upstreamId);
  if (!fresh) throw new Error(`putCopilotQuota: Copilot upstream ${upstreamId} disappeared mid-request`);
  const state = readCopilotUpstreamState(fresh.state);
  await getProviderRepo().upstreams.saveState(
    upstreamId,
    { ...state, quotaSnapshot: { fetchedAt: Date.now(), data: snapshot } } satisfies CopilotUpstreamState,
    { expectedState: fresh.state },
  );
};
