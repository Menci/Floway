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

// One quota bucket. `unlimited` is the authoritative flag on both sources, and
// it is the only one: the headers spell an uncapped bucket `ent=-1&totRem=-1`
// (from which we derive the flag), while the REST body reports the same bucket
// as `unlimited: true` with `entitlement: 0` and `quota_remaining: 0`. Reading
// either number to infer a cap is wrong on one source or the other.
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
    resetAt ??= fields.get('rst');
  });

  if (Object.keys(quotas).length === 0) return null;
  return { observed_at: now.toISOString(), reset_at: resetAt, quotas };
};

// `GET /copilot_internal/user`. Beyond the fields projected below, the body also
// carries `credits_used`, `overage_entitlement`, `has_quota`,
// `token_based_billing` (the AI-Credits vs. premium-interactions
// discriminator), a per-bucket `timestamp_utc`, and the seat's plan and org
// metadata. None of it has a consumer yet, and the header path cannot supply
// any of it — surfacing one would mean a field that silently blanks out
// whenever the passive path wins the race. Widen this interface and
// `projectCopilotUsageResponse` together when something needs them.
//
// `quota_snapshots` is optional because a free / limited seat reports its
// entitlement through `limited_user_quotas` + `monthly_quotas` instead and
// omits the map entirely. We do not read those: the header path covers those
// seats from their first request, and a body we cannot project reads as "no
// buckets" rather than as a gateway error.
// Prior art on the optionality:
// https://github.com/raycast/extensions/blob/main/extensions/agent-usage/src/copilot/fetcher.ts
// https://github.com/onllm-dev/onWatch/blob/main/internal/api/copilot_types.go
export interface CopilotUsageResponse {
  access_type_sku: string;
  copilot_plan: string;
  quota_reset_date_utc?: string;
  quota_snapshots?: Record<string, {
    entitlement: number;
    overage_count: number;
    overage_permitted: boolean;
    percent_remaining: number;
    quota_remaining: number;
    unlimited: boolean;
  }>;
}

// Same null contract as `parseCopilotQuotaHeaders`: a body that reports no
// buckets is "nothing observed", not "everything is zero". Returning a
// well-formed empty snapshot here would let an operator's refresh overwrite a
// good reading the header path had already harvested — which is exactly the
// seat class that reaches this branch.
export const projectCopilotUsageResponse = (body: CopilotUsageResponse, now: Date): CopilotQuotaSnapshot | null => {
  const quotas: Record<string, CopilotQuotaDetail> = {};
  for (const [quotaId, detail] of Object.entries(body.quota_snapshots ?? {})) {
    if (isUnsafeQuotaId(quotaId)) continue;
    quotas[quotaId] = {
      entitlement: detail.entitlement,
      overage_count: detail.overage_count,
      overage_permitted: detail.overage_permitted,
      percent_remaining: detail.percent_remaining,
      quota_remaining: detail.quota_remaining,
      unlimited: detail.unlimited,
    };
  }
  if (Object.keys(quotas).length === 0) return null;
  return {
    observed_at: now.toISOString(),
    reset_at: body.quota_reset_date_utc ?? null,
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
