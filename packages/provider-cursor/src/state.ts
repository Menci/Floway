// Gateway-managed Cursor credential state, persisted in upstreams.state_json.
// Writes happen via UpstreamRepo.saveState with optimistic concurrency keyed
// on the prior state JSON.

export type CursorCredentialHealth = 'active' | 'session_terminated' | 'refresh_failed';

// Short-lived OAuth access token minted by exchanging the stored refresh_token
// against /auth/exchange_user_api_key. The refresh_token itself stays on
// CursorAccountCredential so a KV/cache wipe never forces operator re-import.
export interface CursorAccessTokenEntry {
  token: string;
  expiresAt: number; // unix ms
  refreshedAt: string; // ISO 8601
}

// One account's autonomous credential state, joined back to its identity in
// CursorUpstreamConfig.accounts via `userId`.
export interface CursorAccountCredential {
  userId: string;
  // Cursor may rotate refresh_token on /auth/exchange_user_api_key. Stored in
  // D1 (not KV) so KV eviction never forces operator re-import.
  refresh_token: string;
  state: CursorCredentialHealth;
  state_message?: string;
  // ISO 8601, written on every state transition.
  state_updated_at: string;
  accessToken: CursorAccessTokenEntry | null;
}

export interface CursorUpstreamState {
  accounts: CursorAccountCredential[];
  // Observed per-model context windows recovered from the RunSSE stream's
  // ConversationTokenDetails.maxTokens, keyed by `${maxMode ? 'max' : 'norm'}:${modelId}`
  // so the two Max-Mode variants of a model cache separately. Best-effort and
  // TTL-bounded (see context-window.ts): the catalog prefers a fresh entry over
  // the tooltip-derived heuristic. Absent on legacy rows.
  modelContext?: Record<string, CursorModelContextEntry>;
}

// One observed context window: the model's maxTokens and when it was seen.
export interface CursorModelContextEntry {
  maxTokens: number;
  at: number; // unix ms
}

const ALLOWED_CREDENTIAL_KEYS_MAP: Record<keyof CursorAccountCredential, true> = {
  userId: true,
  refresh_token: true,
  state: true,
  state_message: true,
  state_updated_at: true,
  accessToken: true,
};

const ALLOWED_STATE_KEYS_MAP: Record<keyof CursorUpstreamState, true> = {
  accounts: true,
  modelContext: true,
};

const ALLOWED_ACCESS_TOKEN_KEYS_MAP: Record<keyof CursorAccessTokenEntry, true> = {
  token: true,
  expiresAt: true,
  refreshedAt: true,
};

const assertCursorAccessTokenEntry = (value: unknown, where: string): void => {
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

const assertCursorAccountCredential = (value: unknown, where: string): void => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError(`${where} must be a plain object`);
  }
  const obj = value as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    if (!(key in ALLOWED_CREDENTIAL_KEYS_MAP)) {
      throw new TypeError(`${where} has unexpected key '${key}'`);
    }
  }
  if (typeof obj.userId !== 'string' || obj.userId === '') {
    throw new TypeError(`${where}.userId must be a non-empty string`);
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
  if (obj.accessToken !== undefined && obj.accessToken !== null) {
    assertCursorAccessTokenEntry(obj.accessToken, `${where}.accessToken`);
  }
};

const assertCursorModelContext = (value: unknown, where: string): void => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError(`${where} must be a plain object`);
  }
  for (const [modelKey, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw new TypeError(`${where}['${modelKey}'] must be a plain object`);
    }
    const obj = entry as Record<string, unknown>;
    if (typeof obj.maxTokens !== 'number' || !Number.isFinite(obj.maxTokens)) {
      throw new TypeError(`${where}['${modelKey}'].maxTokens must be a finite number`);
    }
    if (typeof obj.at !== 'number' || !Number.isFinite(obj.at)) {
      throw new TypeError(`${where}['${modelKey}'].at must be a finite number`);
    }
  }
};

export function assertCursorUpstreamState(value: unknown): asserts value is CursorUpstreamState {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('CursorUpstreamState must be a plain object');
  }
  const obj = value as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    if (!(key in ALLOWED_STATE_KEYS_MAP)) {
      throw new TypeError(`CursorUpstreamState has unexpected key '${key}'`);
    }
  }
  if (!Array.isArray(obj.accounts)) {
    throw new TypeError('CursorUpstreamState.accounts must be an array');
  }
  if (obj.accounts.length !== 1) {
    throw new TypeError(`CursorUpstreamState.accounts must hold exactly one account (got ${obj.accounts.length})`);
  }
  for (let i = 0; i < obj.accounts.length; i++) {
    assertCursorAccountCredential(obj.accounts[i], `CursorUpstreamState.accounts[${i}]`);
  }
  if (obj.modelContext !== undefined) {
    assertCursorModelContext(obj.modelContext, 'CursorUpstreamState.modelContext');
  }
}

// Boundary normalization: legacy rows may carry no accessToken key; the typed
// contract promises null rather than undefined. Shallow copy with absent →
// null; the original raw is left untouched for CAS expectedState.
export const readCursorUpstreamState = (raw: unknown): CursorUpstreamState => {
  assertCursorUpstreamState(raw);
  return {
    ...raw,
    accounts: raw.accounts.map(account => ({
      ...account,
      accessToken: account.accessToken ?? null,
    })),
  };
};
