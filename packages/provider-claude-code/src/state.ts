// Gateway-managed Claude Code credential state, persisted in
// upstreams.state_json. Writes happen via UpstreamRepo.saveState, which applies
// the caller's mutator to the stored document and retries it against the winner
// of a concurrent write.
//
// The shape carries the long-lived refresh token (rotated on every refresh
// call) plus a cached short-lived access token and the most recent
// `anthropic-ratelimit-unified-*` snapshot. The asserter calls into quota.ts
// for the snapshot's inner shape so consumers see the typed `data` field
// without re-casting at every call site.
//
// Two credential kinds share this shape, discriminated by `tokenKind`:
//
// - `oauth`: a short-lived access token plus a rotating refresh token.
//   Every refresh call mints a new access token AND rotates the refresh
//   token; the access-token module commits both together.
// - `setup-token`: a long-lived (~1 year) inference-only bearer with NO
//   refresh token. The `accessToken` entry IS the credential — when it
//   expires the operator must re-import. `refreshToken` is null. The
//   cache short-circuits the refresh path for this kind.

import { assertClaudeCodeQuotaSnapshot, type ClaudeCodeQuotaSnapshot } from './quota.ts';

// Short-lived OAuth access token minted by exchanging the stored refreshToken
// against /v1/oauth/token. The refreshToken itself stays on
// ClaudeCodeAccountCredential so a KV/cache wipe never forces operator
// re-import; only the minted token (and its expiry) belong in state alongside
// it. `expiresAt` is unix ms; `refreshedAt` is ISO 8601, matching the
// QuotaSnapshotEntry convention below.
export interface ClaudeCodeAccessTokenEntry {
  token: string;
  expiresAt: number;
  refreshedAt: string;
}

// Most recent quota observation derived from /v1/messages response headers.
// `fetchedAt` is unix ms; `data` is the parsed snapshot whose shape is owned
// by quota.ts and validated by the asserter on read.
export interface ClaudeCodeQuotaSnapshotEntry {
  fetchedAt: number;
  data: ClaudeCodeQuotaSnapshot;
}

// Most recent /api/oauth/usage probe. Stored verbatim because Anthropic
// adds fields (overage, prior-utilization, ...) on its own schedule; the
// dashboard walks known keys and ignores the rest.
export interface ClaudeCodeUsageProbeSnapshotEntry {
  fetchedAt: number;
  data: unknown;
}

// One account's gateway-written credential state, joined back to its identity in
// ClaudeCodeUpstreamConfig.accounts via `accountUuid`. The `tokenKind` axis
// crosses with the `state` (health) axis: each combination is independently
// valid on the wire, so the type is a cartesian product of both unions.
export type ClaudeCodeAccountCredential =
  & ClaudeCodeAccountCredentialBase
  & ClaudeCodeAccountCredentialTokenKind
  & ClaudeCodeAccountCredentialHealth;

interface ClaudeCodeAccountCredentialBase {
  accountUuid: string;
  // ISO 8601, written on every state transition (initial import, rotation,
  // terminal-state flip). The mutation paths always set it together with
  // `state`, so it's required on the wire.
  stateUpdatedAt: string;
  accessToken: ClaudeCodeAccessTokenEntry | null;
  quotaSnapshot: ClaudeCodeQuotaSnapshotEntry | null;
  // Most recent /api/oauth/usage probe. Populated by the operator-driven
  // /upstreams/claude-code/probe route; the data-plane hot path never writes it.
  usageProbeSnapshot: ClaudeCodeUsageProbeSnapshotEntry | null;
}

// The credential class. `oauth` carries a non-empty rotating refresh token
// that the access-token module rotates on every refresh round-trip; `setup-token` is the
// long-lived inference-only bearer with no refresh counterpart.
type ClaudeCodeAccountCredentialTokenKind =
  | { tokenKind: 'oauth'; refreshToken: string }
  | { tokenKind: 'setup-token'; refreshToken: null };

// `active` carries no message; terminal states carry the upstream's terminal
// message so the dashboard can render it and ensureClaudeCodeAccessToken can
// surface it through ClaudeCodeOAuthSessionTerminatedError without inventing
// a fallback string.
type ClaudeCodeAccountCredentialHealth =
  | { state: 'active'; stateMessage?: undefined }
  | { state: 'session_terminated' | 'refresh_failed'; stateMessage: string };

// Account-pool state. The asserter enforces exactly one account, mirroring
// the same invariant on ClaudeCodeUpstreamConfig.
export interface ClaudeCodeUpstreamState {
  accounts: ClaudeCodeAccountCredential[];
}

// Strict shape gate shared by every asserter in this file: rejects unknown
// keys so a stale field on disk surfaces loudly instead of silently shipping
// to the dashboard.
const assertOnlyKeys = (obj: Record<string, unknown>, allowed: readonly string[], where: string): void => {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(obj)) {
    if (!allowedSet.has(key)) {
      throw new TypeError(`${where} has unexpected key '${key}'`);
    }
  }
};

const ACCESS_TOKEN_KEYS = ['token', 'expiresAt', 'refreshedAt'] as const;
const QUOTA_SNAPSHOT_KEYS = ['fetchedAt', 'data'] as const;
const USAGE_PROBE_SNAPSHOT_KEYS = ['fetchedAt', 'data'] as const;
const CREDENTIAL_KEYS = ['accountUuid', 'tokenKind', 'refreshToken', 'state', 'stateMessage', 'stateUpdatedAt', 'accessToken', 'quotaSnapshot', 'usageProbeSnapshot'] as const;
const STATE_KEYS = ['accounts'] as const;

const assertClaudeCodeAccessTokenEntry = (value: unknown, where: string): void => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError(`${where} must be a plain object`);
  }
  const obj = value as Record<string, unknown>;
  assertOnlyKeys(obj, ACCESS_TOKEN_KEYS, where);
  if (typeof obj.token !== 'string' || obj.token === '') {
    throw new TypeError(`${where}.token must be a non-empty string`);
  }
  if (typeof obj.expiresAt !== 'number' || !Number.isFinite(obj.expiresAt)) {
    throw new TypeError(`${where}.expiresAt must be a finite number`);
  }
  if (typeof obj.refreshedAt !== 'string' || obj.refreshedAt === '') {
    throw new TypeError(`${where}.refreshedAt must be a non-empty string`);
  }
};

const assertClaudeCodeQuotaSnapshotEntry = (value: unknown, where: string): void => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError(`${where} must be a plain object`);
  }
  const obj = value as Record<string, unknown>;
  assertOnlyKeys(obj, QUOTA_SNAPSHOT_KEYS, where);
  if (typeof obj.fetchedAt !== 'number' || !Number.isFinite(obj.fetchedAt)) {
    throw new TypeError(`${where}.fetchedAt must be a finite number`);
  }
  assertClaudeCodeQuotaSnapshot(obj.data, `${where}.data`);
};

// `data` is intentionally untyped: the upstream's /api/oauth/usage body
// is the source of truth, and Anthropic adds fields (priorIsUsingOverage,
// hadPriorUtilizationData, ...) on its own schedule. We require only that
// it is a non-null object so the dashboard can walk it safely.
const assertClaudeCodeUsageProbeSnapshotEntry = (value: unknown, where: string): void => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError(`${where} must be a plain object`);
  }
  const obj = value as Record<string, unknown>;
  assertOnlyKeys(obj, USAGE_PROBE_SNAPSHOT_KEYS, where);
  if (typeof obj.fetchedAt !== 'number' || !Number.isFinite(obj.fetchedAt)) {
    throw new TypeError(`${where}.fetchedAt must be a finite number`);
  }
  if (typeof obj.data !== 'object' || obj.data === null || Array.isArray(obj.data)) {
    throw new TypeError(`${where}.data must be a plain object`);
  }
};

const assertClaudeCodeAccountCredential = (value: unknown, where: string): void => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError(`${where} must be a plain object`);
  }
  const obj = value as Record<string, unknown>;
  assertOnlyKeys(obj, CREDENTIAL_KEYS, where);
  if (typeof obj.accountUuid !== 'string' || obj.accountUuid === '') {
    throw new TypeError(`${where}.accountUuid must be a non-empty string`);
  }
  if (obj.tokenKind !== 'oauth' && obj.tokenKind !== 'setup-token') {
    throw new TypeError(`${where}.tokenKind must be one of 'oauth' | 'setup-token', got ${String(obj.tokenKind)}`);
  }
  // Refresh-token presence is keyed off `tokenKind`. `oauth` requires a
  // non-empty rotating refresh token; `setup-token` carries `null` because
  // the long-lived bearer has no refresh counterpart.
  if (obj.tokenKind === 'setup-token') {
    if (obj.refreshToken !== null) {
      throw new TypeError(`${where}.refreshToken must be null for setup-token`);
    }
  } else if (typeof obj.refreshToken !== 'string' || obj.refreshToken === '') {
    throw new TypeError(`${where}.refreshToken must be a non-empty string for oauth`);
  }
  if (obj.state !== 'active' && obj.state !== 'session_terminated' && obj.state !== 'refresh_failed') {
    throw new TypeError(`${where}.state must be one of 'active' | 'session_terminated' | 'refresh_failed', got ${String(obj.state)}`);
  }
  // Terminal states carry the upstream's terminal message; 'active' must not.
  // This split keeps the access-token module from inventing a fallback string
  // when it surfaces ClaudeCodeOAuthSessionTerminatedError.
  if (obj.state === 'active') {
    if (obj.stateMessage !== undefined) {
      throw new TypeError(`${where}.stateMessage must be absent on active state`);
    }
  } else if (typeof obj.stateMessage !== 'string' || obj.stateMessage === '') {
    throw new TypeError(`${where}.stateMessage must be a non-empty string on terminal state`);
  }
  if (typeof obj.stateUpdatedAt !== 'string' || obj.stateUpdatedAt === '') {
    throw new TypeError(`${where}.stateUpdatedAt must be a non-empty ISO string`);
  }
  if (obj.accessToken !== null) {
    assertClaudeCodeAccessTokenEntry(obj.accessToken, `${where}.accessToken`);
  }
  if (obj.quotaSnapshot !== null) {
    assertClaudeCodeQuotaSnapshotEntry(obj.quotaSnapshot, `${where}.quotaSnapshot`);
  }
  if (obj.usageProbeSnapshot !== null) {
    assertClaudeCodeUsageProbeSnapshotEntry(obj.usageProbeSnapshot, `${where}.usageProbeSnapshot`);
  }
};

export function assertClaudeCodeUpstreamState(value: unknown): asserts value is ClaudeCodeUpstreamState {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('ClaudeCodeUpstreamState must be a plain object');
  }
  const obj = value as Record<string, unknown>;
  assertOnlyKeys(obj, STATE_KEYS, 'ClaudeCodeUpstreamState');
  if (!Array.isArray(obj.accounts)) {
    throw new TypeError('ClaudeCodeUpstreamState.accounts must be an array');
  }
  if (obj.accounts.length !== 1) {
    throw new TypeError(`ClaudeCodeUpstreamState.accounts must hold exactly one account (got ${obj.accounts.length})`);
  }
  for (let i = 0; i < obj.accounts.length; i++) {
    assertClaudeCodeAccountCredential(obj.accounts[i], `ClaudeCodeUpstreamState.accounts[${i}]`);
  }
}

// Asserts the wire shape and returns the typed view. The asserter rejects
// absent `accessToken` / `quotaSnapshot` / `usageProbeSnapshot` keys (they
// must be explicit `null` when not populated). Every write supplies every
// field explicitly; no on-disk normalization is performed here.
export const readClaudeCodeUpstreamState = (raw: unknown): ClaudeCodeUpstreamState => {
  assertClaudeCodeUpstreamState(raw);
  return raw;
};

// Immutable patch helper: replace the sole account by running `patch` over
// it. The asserter pins `accounts` to exactly one entry, so this helper
// always rewrites index 0; encoding that invariant in the name keeps call
// sites free of a `0` literal whose meaning would otherwise have to be
// re-derived on every read.
export const replaceSoleAccount = (
  state: ClaudeCodeUpstreamState,
  patch: (account: ClaudeCodeAccountCredential) => ClaudeCodeAccountCredential,
): ClaudeCodeUpstreamState => ({
  ...state,
  accounts: [patch(state.accounts[0])],
});
