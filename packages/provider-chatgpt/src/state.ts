// Gateway-managed ChatGPT credential state, persisted in upstreams.state_json.
// Writes happen via UpstreamRepo.saveState, which read-modify-writes the row
// and replays the mutator whenever a concurrent writer wins.

import { assertAllowedObjectKeys, assertStringOrNull, isUnsafeObjectKey } from './auth/guards.ts';
import { getProviderRepo } from '@floway-dev/provider';

export type ChatGPTAccountCredentialHealth = 'active' | 'session_terminated' | 'refresh_failed';

// Short-lived OAuth access state minted by exchanging the stored refresh_token
// against /oauth/token. The refresh_token itself stays on ChatGPTAccountCredential
// so a cache loss never forces operator re-import; this entry keeps the minted
// token, its lifetime, and the account's latest observed capability metadata.
export interface ChatGPTAccessTokenEntry {
  token: string;
  // Unix ms, or null when the import source did not state the bearer's expiry
  // and the token itself is opaque. A null expiry is not "expired" — it means
  // the upstream's rejection is the only signal we have.
  expiresAt: number | null;
  refreshedAt: string;     // ISO 8601
  // Observed from refresh id_tokens and retained across later tokens that omit
  // the claim. It is absent only when no refresh has supplied it and legacy
  // state has none, in which case callers use the import-time identity.
  planType?: string;
  // Observation time for planType, independent from the token's refreshedAt
  // so out-of-order token writes cannot promote an older plan observation.
  planObservedAt?: string;
}

// Parsed ChatGPT quota reading derived from upstream response headers by the
// parser in quota.ts, embedded into persisted state by ChatGPTQuotaSnapshotEntry.
export interface ChatGPTQuotaSnapshot {
  observed_at: string;
  active_limit?: string;
  plan_type?: string;

  primary_used_percent?: number;
  primary_window_minutes?: number;
  primary_reset_after_at?: string;

  secondary_used_percent?: number;
  secondary_window_minutes?: number;
  secondary_reset_after_at?: string;

  credits_has_credits?: boolean;
  credits_balance?: number;

  // Present only when this snapshot was written as a result of a 429.
  ratelimited_until?: string;
}

export type ChatGPTQuotaSnapshotMap = Record<string, ChatGPTQuotaSnapshot>;

// Most recent quota observation derived from upstream response headers.
// `fetchedAt` is unix ms; `data` is the parsed snapshot, validated by quota.ts
// at the boundary where it's read for dashboard display.
export interface ChatGPTQuotaSnapshotEntry {
  fetchedAt: number;
  data: ChatGPTQuotaSnapshot;
}

export type ChatGPTQuotaSnapshotEntryMap = Record<string, ChatGPTQuotaSnapshotEntry>;

// One account's autonomous credential state, joined back to its identity in
// ChatGPTUpstreamConfig.accounts via `chatgptAccountId`.
export interface ChatGPTAccountCredential {
  // Null when no import source could name the account. Under the one-account-
  // per-upstream invariant that is still a stable slot: the config carries the
  // same null and the two join on it like any other value.
  chatgptAccountId: string | null;
  // OpenAI rotates refresh_token on every /oauth/token call. Stored in D1
  // (not KV) so KV eviction never forces operator re-import. Null marks an
  // access-only credential that cannot be renewed at all.
  refresh_token: string | null;
  state: ChatGPTAccountCredentialHealth;
  state_message?: string;
  // ISO 8601, written on every state transition (initial import, rotation,
  // terminal-state flip). The mutation paths in routes.ts and provider.ts
  // always set it together with `state`, so it's required on the wire.
  state_updated_at: string;
  // Stable per-account installation id, surfaced to the ChatGPT upstream as
  // `client_metadata['x-codex-installation-id']` so per-account requests look
  // like a single persisted device rather than rotating per call. Minted at
  // import time; the matching D1 / sqlite migration backfills the field on
  // older rows so the contract is closed end-to-end.
  openaiDeviceId: string;
  // accessToken / quotaSnapshot were added after the initial schema; absent on
  // pre-existing rows. The asserter accepts that absent-key case unchanged;
  // `readChatGPTUpstreamState` is the boundary that normalizes absent → `null`
  // on a shallow copy, so consumers can rely on the typed `null` slot here.
  accessToken: ChatGPTAccessTokenEntry | null;
  quotaSnapshot: ChatGPTQuotaSnapshotEntryMap | null;
}

// Account-pool state. v1 always carries exactly one entry; the asserter
// enforces that, mirroring the same invariant on ChatGPTUpstreamConfig.
export interface ChatGPTUpstreamState {
  accounts: ChatGPTAccountCredential[];
}

export const findChatGPTAccountIndex = (state: ChatGPTUpstreamState, accountId: string | null): number =>
  state.accounts.findIndex(account => account.chatgptAccountId === accountId);

export const replaceChatGPTAccount = (
  state: ChatGPTUpstreamState,
  index: number,
  patch: (account: ChatGPTAccountCredential) => ChatGPTAccountCredential,
): ChatGPTUpstreamState => ({
  ...state,
  accounts: state.accounts.map((account, currentIndex) => currentIndex === index ? patch(account) : account),
});

const ALLOWED_CREDENTIAL_KEYS_MAP: Record<keyof ChatGPTAccountCredential, true> = {
  chatgptAccountId: true,
  refresh_token: true,
  state: true,
  state_message: true,
  state_updated_at: true,
  openaiDeviceId: true,
  accessToken: true,
  quotaSnapshot: true,
};

const CREDENTIAL_ALLOWED_KEYS: ReadonlySet<string> = new Set(Object.keys(ALLOWED_CREDENTIAL_KEYS_MAP));

const ALLOWED_STATE_KEYS_MAP: Record<keyof ChatGPTUpstreamState, true> = {
  accounts: true,
};

const STATE_ALLOWED_KEYS: ReadonlySet<string> = new Set(Object.keys(ALLOWED_STATE_KEYS_MAP));

const ALLOWED_ACCESS_TOKEN_KEYS_MAP: Record<keyof ChatGPTAccessTokenEntry, true> = {
  token: true,
  expiresAt: true,
  refreshedAt: true,
  planType: true,
  planObservedAt: true,
};

const ACCESS_TOKEN_ALLOWED_KEYS: ReadonlySet<string> = new Set(Object.keys(ALLOWED_ACCESS_TOKEN_KEYS_MAP));

const ALLOWED_QUOTA_SNAPSHOT_KEYS_MAP: Record<keyof ChatGPTQuotaSnapshotEntry, true> = {
  fetchedAt: true,
  data: true,
};

const QUOTA_SNAPSHOT_ALLOWED_KEYS: ReadonlySet<string> = new Set(Object.keys(ALLOWED_QUOTA_SNAPSHOT_KEYS_MAP));

const assertChatGPTAccessTokenEntry = (value: unknown, where: string): void => {
  const obj = assertAllowedObjectKeys(value, where, ACCESS_TOKEN_ALLOWED_KEYS);
  if (typeof obj.token !== 'string' || obj.token === '') {
    throw new TypeError(`${where}.token must be a non-empty string`);
  }
  if (obj.expiresAt !== null && (typeof obj.expiresAt !== 'number' || !Number.isFinite(obj.expiresAt))) {
    throw new TypeError(`${where}.expiresAt must be a finite number or null`);
  }
  if (typeof obj.refreshedAt !== 'string' || obj.refreshedAt === '') {
    throw new TypeError(`${where}.refreshedAt must be a non-empty string`);
  }
  if (obj.planType !== undefined && (typeof obj.planType !== 'string' || obj.planType === '')) {
    throw new TypeError(`${where}.planType must be a non-empty string when present`);
  }
  if (obj.planObservedAt !== undefined && (typeof obj.planObservedAt !== 'string' || obj.planObservedAt === '')) {
    throw new TypeError(`${where}.planObservedAt must be a non-empty string when present`);
  }
  if (obj.planObservedAt !== undefined && obj.planType === undefined) {
    throw new TypeError(`${where}.planObservedAt requires planType`);
  }
};

// Deeper validation of the snapshot's `data` payload lives in quota.ts, which
// owns the snapshot shape and re-checks at every consumer boundary. Here we
// only confirm the wrapper is a plain object so an unrelated key (array,
// scalar) doesn't slip past.
const assertChatGPTQuotaSnapshotEntry = (value: unknown, where: string): void => {
  const obj = assertAllowedObjectKeys(value, where, QUOTA_SNAPSHOT_ALLOWED_KEYS);
  if (typeof obj.fetchedAt !== 'number' || !Number.isFinite(obj.fetchedAt)) {
    throw new TypeError(`${where}.fetchedAt must be a finite number`);
  }
  if (typeof obj.data !== 'object' || obj.data === null || Array.isArray(obj.data)) {
    throw new TypeError(`${where}.data must be a plain object`);
  }
};

const assertChatGPTQuotaSnapshotEntryMap = (value: unknown, where: string): void => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError(`${where} must be a plain object`);
  }
  const obj = value as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    if (key === '' || isUnsafeObjectKey(key)) {
      throw new TypeError(`${where} has invalid active limit key '${key}'`);
    }
    assertChatGPTQuotaSnapshotEntry(obj[key], `${where}.${key}`);
  }
};

const assertChatGPTAccountCredential = (value: unknown, where: string): void => {
  const obj = assertAllowedObjectKeys(value, where, CREDENTIAL_ALLOWED_KEYS);
  assertStringOrNull(obj.chatgptAccountId, `${where}.chatgptAccountId`);
  assertStringOrNull(obj.refresh_token, `${where}.refresh_token`);
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
  // the shape when the key is present and non-null; the absent → `null`
  // normalization that satisfies the typed contract happens in
  // `readChatGPTUpstreamState` on a shallow copy instead.
  if (obj.accessToken !== undefined && obj.accessToken !== null) {
    assertChatGPTAccessTokenEntry(obj.accessToken, `${where}.accessToken`);
  }
  if (obj.quotaSnapshot !== undefined && obj.quotaSnapshot !== null) {
    assertChatGPTQuotaSnapshotEntryMap(obj.quotaSnapshot, `${where}.quotaSnapshot`);
  }
};

export function assertChatGPTUpstreamState(value: unknown): asserts value is ChatGPTUpstreamState {
  // state_json round-trips through canonical serialization, so any surviving
  // key is persisted. Reject unknown keys to keep the on-disk shape closed.
  const obj = assertAllowedObjectKeys(value, 'ChatGPTUpstreamState', STATE_ALLOWED_KEYS);
  if (!Array.isArray(obj.accounts)) {
    throw new TypeError('ChatGPTUpstreamState.accounts must be an array');
  }
  if (obj.accounts.length !== 1) {
    throw new TypeError(`ChatGPTUpstreamState.accounts must hold exactly one account (got ${obj.accounts.length})`);
  }
  for (let i = 0; i < obj.accounts.length; i++) {
    assertChatGPTAccountCredential(obj.accounts[i], `ChatGPTUpstreamState.accounts[${i}]`);
  }
}

// Boundary normalization: legacy rows may carry no `accessToken` /
// `quotaSnapshot` key; the typed contract on `ChatGPTAccountCredential`
// promises `null` rather than `undefined`. Build a shallow copy of the
// state with absent → `null` so consumers can rely on `=== null` checks
// without seeing legacy rows escape unfilled. `raw` is left untouched, which
// keeps the state-write helpers free to hand it straight back to the repo to
// say there is nothing to write.
export const readChatGPTUpstreamState = (raw: unknown): ChatGPTUpstreamState => {
  assertChatGPTUpstreamState(raw);
  return {
    ...raw,
    accounts: raw.accounts.map(account => ({
      ...account,
      accessToken: account.accessToken ?? null,
      quotaSnapshot: account.quotaSnapshot ?? null,
    })),
  };
};

// State-transition writes for both planes. The operator-facing refresh handler
// in the gateway delegates to these so the provider owns its own state writes,
// and the data plane's createChatGPTProvider routes the same fields through the
// same helpers. The control plane no-ops on a missing account rather than
// throw, matching the refresh contract that a state slot it cannot address
// should be left alone (saveState skips the write when the mutator returns
// state unchanged), while the data plane passes onMissing:'throw' so a lost
// credential fails loudly instead of silently persisting nothing.

// Shared state-write scaffold: stamps state_updated_at on every successful
// account patch and no-ops on a missing account, so the transitions below
// can't silently drop the write timestamp or address a state slot they can't
// find. Pass { onMissing: 'throw' } to fail loudly on a missing account.
const updateChatGPTAccountState = async (
  upstreamId: string,
  accountId: string | null,
  stamp: string,
  patch: (account: ChatGPTAccountCredential) => ChatGPTAccountCredential,
  options?: { onMissing: 'noop' | 'throw' },
): Promise<void> => {
  await getProviderRepo().upstreams.saveState(upstreamId, current => {
    const state = readChatGPTUpstreamState(current);
    const idx = findChatGPTAccountIndex(state, accountId);
    if (idx < 0) {
      if (options?.onMissing === 'throw') {
        throw new TypeError(`ChatGPT upstream ${upstreamId} state has no credential for account ${accountId}`);
      }
      return current;
    }
    return replaceChatGPTAccount(state, idx, account => ({ ...patch(account), state_updated_at: stamp }));
  });
};

export const persistChatGPTRefreshTokenRotation = async (
  upstreamId: string,
  accountId: string | null,
  newRefreshToken: string,
  options?: { onMissing: 'noop' | 'throw' },
): Promise<void> => {
  // OpenAI rotates the refresh_token on every /oauth/token call. Stamped
  // before the write so a replay against a winning sibling produces the same
  // document rather than a later timestamp.
  const rotatedAt = new Date().toISOString();
  await updateChatGPTAccountState(upstreamId, accountId, rotatedAt, account => ({
    ...account,
    refresh_token: newRefreshToken,
  }), options);
};

export const persistChatGPTRefreshFailure = async (
  upstreamId: string,
  accountId: string | null,
  message: string,
): Promise<void> => {
  return await persistChatGPTTerminalState(upstreamId, accountId, 'refresh_failed', message);
};

export const persistChatGPTTerminalState = async (
  upstreamId: string,
  accountId: string | null,
  state: 'session_terminated' | 'refresh_failed',
  message: string,
  options?: { onMissing: 'noop' | 'throw' },
): Promise<void> => {
  // Stamped before the write so a replay against a winning sibling produces
  // the same document rather than a later timestamp.
  const flippedAt = new Date().toISOString();
  await updateChatGPTAccountState(upstreamId, accountId, flippedAt, account => {
    // Clear any cached access token on the terminal flip — once the
    // credential is dead the cached token is dead too, and leaving it would
    // confuse the dashboard's status panel.
    return {
      ...account,
      state,
      state_message: message,
      accessToken: null,
    };
  }, options);
};
