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
//                consumption renders "0 / 0, 100% used" on a seat that simply
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

// `-1` denotes an unlimited entitlement, per GitHub's own SDK declaration of
// this field — `@github/copilot-sdk@1.0.8`, `dist/generated/rpc.d.ts`:
// "Number of requests/units included in the entitlement for this period; `-1`
// denotes an unlimited entitlement."
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

// `GET /copilot_internal/user`. Every field is optional, including every field
// inside a bucket — that is how GitHub's own SDK declares this endpoint, in
// `@github/copilot-sdk@1.0.8`, `dist/generated/rpc.d.ts` (`quota_snapshots?` on
// `CopilotUserResponse`, and `entitlement?` / `percent_remaining?` /
// `quota_remaining?` / `unlimited?` on `CopilotUserResponseQuotaSnapshotsChat`).
// The captures we have carry every field, so the SDK is the only source for the
// optionality; it is a generated declaration file rather than a runtime schema,
// and the interfaces are marked `@experimental`.
//
// The interface declares only what we project, but the body carries a good deal
// more, and the rest is enumerated here so the next feature that wants one of
// these can see it is already on the wire. From the 2026-07-08 capture linked
// below, at the top level: `access_type_sku` and `copilot_plan` (the seat's SKU
// and plan), `token_based_billing` (the AI-Credits vs. premium-interactions
// discriminator), `quota_reset_date` (the date-only form of
// `quota_reset_date_utc`), `endpoints` (the same per-tier host map the token
// exchange returns), the seat's identity and org metadata (`login`,
// `assigned_date`, `analytics_tracking_id`, `is_staff`, `organization_list`,
// `organization_login_list`), and the entitlement flags (`chat_enabled`,
// `cli_enabled`, `cli_remote_control_enabled`, `cloud_session_storage_enabled`,
// `copilotignore_enabled`, `editor_preview_features_enabled`, `is_mcp_enabled`,
// `can_upgrade_plan`, `can_signup_for_limited`, `restricted_telemetry`). Inside
// each bucket: `quota_id`, `remaining` (the integer form of `quota_remaining`),
// `quota_reset_at`, `timestamp_utc` (per bucket rather than per snapshot), and
// a per-bucket `token_based_billing`. `has_quota` is also there and is the one
// omission with a reason of its own — see `CopilotQuotaDetail` above.
//
// Two further per-bucket fields are on the wire without appearing in any
// capture we hold: `overage_entitlement` (the overage cap, which VS Code reads
// only off `premium_interactions`) and `credits_used` (AI-Credits consumed).
// Microsoft declares both on the body it `JSON.parse`s straight out of this
// endpoint, so this is a declaration of GitHub's shape rather than a client-side
// reshape:
// https://github.com/microsoft/vscode/blob/9afe2783a7239c915d5fc6d1bd9c842f9ca06c2e/src/vs/base/common/defaultAccount.ts#L8-L20
// `overage_entitlement` landed 2026-06-11 (microsoft/vscode#321023) and
// `credits_used` on 2026-07-08 at 19:59Z (microsoft/vscode#325002) — the capture
// below was taken that same day at 12:01Z, hours early, on a seat with no
// overage to report. Neither field appears in `@github/copilot-sdk@1.0.8`, which
// conversely declares a `codex_agent_enabled` no capture carries: both of our
// secondary sources for this endpoint lag the wire, in opposite directions.
//
// Nothing consumes any of it yet, and the header path cannot supply any of it,
// so projecting one today would mean a field that silently blanks out whenever
// the passive path wins the race. Widen this interface and
// `projectCopilotUsageResponse` together when something needs them.
//
// Two body shapes are live at once, split by GitHub's 2026-06-01 AI-Credits
// change. A seat on the current shape reports `quota_snapshots` whatever its
// plan, including free (captured 2026-07-08 on a `free_limited_copilot` seat:
// `chat` 200, `completions` 2000, `premium_interactions` entitlement 0 with
// `has_quota: false`). A seat on the legacy shape reports through
// `limited_user_quotas` (remaining) + `monthly_quotas` (entitlement) and leaves
// `quota_snapshots` empty or absent — we do not read those, so such a body
// projects to "nothing observed" and the header path is what fills the slot.
// Captured current and legacy bodies for the same free SKU, in that order:
// https://github.com/TopiCsarno/yapcap/blob/152ea67c3abd44776268627d58533003099da951/fixtures/copilot/copilot_user_response.json
// https://github.com/bugwz/AIMeter/blob/b93c15558863c3eb3fe1a0e71197c233343c9400/docs/providers/copliot/demo.free.json
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
// recently is what the dashboard shows. `fetchedAt` is stamped outside the
// mutator: the mutator is re-run on a lost race and must return the same
// snapshot each time.
export const putCopilotQuota = async (upstreamId: string, snapshot: CopilotQuotaSnapshot): Promise<void> => {
  const fetchedAt = Date.now();
  await getProviderRepo().upstreams.saveState(upstreamId, current => ({
    ...readCopilotUpstreamState(current),
    quotaSnapshot: { fetchedAt, data: snapshot },
  } satisfies CopilotUpstreamState));
};
