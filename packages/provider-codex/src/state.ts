// Gateway-managed Codex credential state, persisted in upstreams.state_json.
// Writes happen via UpstreamRepo.saveState with optimistic concurrency keyed
// on the prior state JSON.

import type { CodexQuotaSnapshot } from './quota.ts';

export type CodexCredentialHealth = 'active' | 'session_terminated' | 'refresh_failed';

// Short-lived OAuth access token minted by exchanging the stored refresh_token
// against /oauth/token. The refresh_token itself stays on CodexAccountCredential
// so a KV/cache wipe never forces operator re-import; only the minted token
// (and its expiry) belong in state alongside it.
export interface CodexAccessTokenEntry {
  token: string;
  expiresAt: number;       // unix ms
  refreshedAt: string;     // ISO 8601
}

// Most recent quota observation derived from upstream response headers.
// `fetchedAt` is unix ms; `data` is the parsed snapshot, validated by quota.ts
// at the boundary where it's read for dashboard display / rate-limit checks.
export interface CodexQuotaSnapshotEntry {
  fetchedAt: number;
  data: CodexQuotaSnapshot;
}

// One account's autonomous credential state, joined back to its identity in
// CodexUpstreamConfig.accounts via `chatgptAccountId`.
export interface CodexAccountCredential {
  chatgptAccountId: string;
  // OpenAI rotates refresh_token on every /oauth/token call. Stored in D1
  // (not KV) so KV eviction never forces operator re-import.
  refresh_token: string;
  state: CodexCredentialHealth;
  state_message?: string;
  // ISO 8601, written on every state transition (initial import, rotation,
  // terminal-state flip). The mutation paths in routes.ts and provider.ts
  // always set it together with `state`, so it's required on the wire.
  state_updated_at: string;
  // Stable per-account installation id, surfaced to the Codex upstream as
  // `client_metadata['x-codex-installation-id']` so per-account requests look
  // like a single persisted device rather than rotating per call. Minted at
  // import time; the matching D1 / sqlite migration backfills the field on
  // older rows so the contract is closed end-to-end.
  openaiDeviceId: string;
  // accessToken / quotaSnapshot were added after the initial schema; absent on
  // pre-existing rows. The asserter accepts that absent-key case unchanged so
  // we never mutate the input (which would poison CAS via the caller's
  // `fresh.state` reference); `readCodexUpstreamState` is the boundary that
  // normalizes absent → `null` on a shallow copy, so consumers can rely on
  // the typed `null` slot here.
  accessToken: CodexAccessTokenEntry | null;
  quotaSnapshot: CodexQuotaSnapshotEntry | null;
}

// Account-pool state. v1 always carries exactly one entry; the asserter
// enforces that, mirroring the same invariant on CodexUpstreamConfig.
export interface CodexUpstreamState {
  accounts: CodexAccountCredential[];
}

const ALLOWED_CREDENTIAL_KEYS_MAP: Record<keyof CodexAccountCredential, true> = {
  chatgptAccountId: true,
  refresh_token: true,
  state: true,
  state_message: true,
  state_updated_at: true,
  openaiDeviceId: true,
  accessToken: true,
  quotaSnapshot: true,
};

const ALLOWED_STATE_KEYS_MAP: Record<keyof CodexUpstreamState, true> = {
  accounts: true,
};

const ALLOWED_ACCESS_TOKEN_KEYS_MAP: Record<keyof CodexAccessTokenEntry, true> = {
  token: true,
  expiresAt: true,
  refreshedAt: true,
};

const ALLOWED_QUOTA_SNAPSHOT_KEYS_MAP: Record<keyof CodexQuotaSnapshotEntry, true> = {
  fetchedAt: true,
  data: true,
};

const assertCodexAccessTokenEntry = (value: unknown, where: string): void => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError(`${where} must be a plain object`);
  }
  const obj = value as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    if (!(key in ALLOWED_ACCESS_TOKEN_KEYS_MAP)) {
      throw new TypeError(`${where} has unexpected key '${key}'`);
    }
  }
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

// Deeper validation of the snapshot's `data` payload lives in quota.ts, which
// owns the snapshot shape and re-checks at every consumer boundary. Here we
// only confirm the wrapper is a plain object so an unrelated key (array,
// scalar) doesn't slip past.
const assertCodexQuotaSnapshotEntry = (value: unknown, where: string): void => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError(`${where} must be a plain object`);
  }
  const obj = value as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    if (!(key in ALLOWED_QUOTA_SNAPSHOT_KEYS_MAP)) {
      throw new TypeError(`${where} has unexpected key '${key}'`);
    }
  }
  if (typeof obj.fetchedAt !== 'number' || !Number.isFinite(obj.fetchedAt)) {
    throw new TypeError(`${where}.fetchedAt must be a finite number`);
  }
  if (typeof obj.data !== 'object' || obj.data === null || Array.isArray(obj.data)) {
    throw new TypeError(`${where}.data must be a plain object`);
  }
};

const assertCodexAccountCredential = (value: unknown, where: string): void => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError(`${where} must be a plain object`);
  }
  const obj = value as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    if (!(key in ALLOWED_CREDENTIAL_KEYS_MAP)) {
      throw new TypeError(`${where} has unexpected key '${key}'`);
    }
  }
  if (typeof obj.chatgptAccountId !== 'string' || obj.chatgptAccountId === '') {
    throw new TypeError(`${where}.chatgptAccountId must be a non-empty string`);
  }
  if (typeof obj.refresh_token !== 'string' || obj.refresh_token === '') {
    throw new TypeError(`${where}.refresh_token must be a non-empty string`);
  }
  if (obj.state !== 'active' && obj.state !== 'session_terminated' && obj.state !== 'refresh_failed') {
    throw new TypeError(`${where}.state must be one of 'active' | 'session_terminated' | 'refresh_failed', got ${String(obj.state)}`);
  }
  if (obj.state_message !== undefined && typeof obj.state_message !== 'string') {
    throw new TypeError(`${where}.state_message must be a string when present`);
  }
  if (typeof obj.state_updated_at !== 'string' || obj.state_updated_at === '') {
    throw new TypeError(`${where}.state_updated_at must be a non-empty ISO string`);
  }
  if (typeof obj.openaiDeviceId !== 'string' || obj.openaiDeviceId === '') {
    throw new TypeError(`${where}.openaiDeviceId must be a non-empty string`);
  }
  // accessToken / quotaSnapshot were added after the initial schema; absent on
  // pre-existing rows. Accept the absent-key case verbatim and only validate
  // the shape when the key is present and non-null. Mutating the input here
  // (e.g. defaulting to null in place) would propagate through the caller's
  // `fresh.state` reference and poison the CAS `expectedState` — the absent →
  // `null` normalization to satisfy the typed contract happens in
  // `readCodexUpstreamState` on a shallow copy instead.
  if (obj.accessToken !== undefined && obj.accessToken !== null) {
    assertCodexAccessTokenEntry(obj.accessToken, `${where}.accessToken`);
  }
  if (obj.quotaSnapshot !== undefined && obj.quotaSnapshot !== null) {
    assertCodexQuotaSnapshotEntry(obj.quotaSnapshot, `${where}.quotaSnapshot`);
  }
};

export function assertCodexUpstreamState(value: unknown): asserts value is CodexUpstreamState {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('CodexUpstreamState must be a plain object');
  }
  const obj = value as Record<string, unknown>;
  // state_json round-trips through canonical serialization, so any surviving
  // key is persisted. Reject unknown keys to keep the on-disk shape closed.
  for (const key of Object.keys(obj)) {
    if (!(key in ALLOWED_STATE_KEYS_MAP)) {
      throw new TypeError(`CodexUpstreamState has unexpected key '${key}'`);
    }
  }
  if (!Array.isArray(obj.accounts)) {
    throw new TypeError('CodexUpstreamState.accounts must be an array');
  }
  if (obj.accounts.length !== 1) {
    throw new TypeError(`CodexUpstreamState.accounts must hold exactly one account (got ${obj.accounts.length})`);
  }
  for (let i = 0; i < obj.accounts.length; i++) {
    assertCodexAccountCredential(obj.accounts[i], `CodexUpstreamState.accounts[${i}]`);
  }
}

// Boundary normalization: legacy rows may carry no `accessToken` /
// `quotaSnapshot` key; the typed contract on `CodexAccountCredential`
// promises `null` rather than `undefined`. Build a shallow copy of the
// state with absent → `null` so consumers can rely on `=== null` checks
// without seeing legacy rows escape unfilled. The original `raw` is left
// untouched so callers (e.g. access-token-cache, quota) can still pass it
// straight through as the CAS `expectedState`.
export const readCodexUpstreamState = (raw: unknown): CodexUpstreamState => {
  assertCodexUpstreamState(raw);
  return {
    ...raw,
    accounts: raw.accounts.map(account => ({
      ...account,
      accessToken: account.accessToken ?? null,
      quotaSnapshot: account.quotaSnapshot ?? null,
    })),
  };
};
