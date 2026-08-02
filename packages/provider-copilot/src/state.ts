// Gateway-managed Copilot upstream state, persisted in upstreams.state_json.
// The three slots below are written by three independent paths, so each write
// goes through UpstreamRepo.saveState as a mutator that spreads the state it
// is handed and replaces its own slot — that is what keeps a sibling path's
// concurrent write intact.

import type { CopilotKnownModels } from './known-models.ts';
import type { CopilotQuotaSnapshot } from './quota.ts';

// Short-lived Copilot session token minted by exchanging the operator-supplied
// GitHub PAT against /copilot_internal/v2/token. The PAT itself lives in
// CopilotUpstreamConfig; everything that comes back from the exchange — the
// bearer token, its expiry, and the per-tier `endpoints.api` GitHub routes us
// to — belongs in state. The base URL travels with the token because they
// share a lifetime: a seat upgraded to a different tier yields a new bearer
// and a new endpoints.api in the same response.
export interface CopilotTokenEntry {
  token: string;
  expiresAt: number;
  baseUrl: string;
}

// Most recent entitlement observation, from either quota source. `fetchedAt`
// is unix ms — the wrapper matches the slot Codex and Claude Code persist
// their snapshots under, so the state shape and its serializer contract stay
// uniform across the three providers. The dashboard reads the observation time
// off the snapshot's own `observed_at`, which is the only one of the two that
// also travels on the refresh endpoint's reply.
// No TTL: a Copilot seat resets monthly, so an old snapshot rendered with its
// timestamp is more useful to an operator than an empty card, and any traffic
// on the upstream replaces it.
export interface CopilotQuotaSnapshotEntry {
  fetchedAt: number;
  data: CopilotQuotaSnapshot;
}

export interface CopilotUpstreamState {
  knownModels: CopilotKnownModels | null;
  copilotToken: CopilotTokenEntry | null;
  quotaSnapshot: CopilotQuotaSnapshotEntry | null;
}

const ALLOWED_STATE_KEYS_MAP: Record<keyof CopilotUpstreamState, true> = {
  knownModels: true,
  copilotToken: true,
  quotaSnapshot: true,
};

const ALLOWED_TOKEN_KEYS_MAP: Record<keyof CopilotTokenEntry, true> = {
  token: true,
  expiresAt: true,
  baseUrl: true,
};

const ALLOWED_QUOTA_SNAPSHOT_KEYS_MAP: Record<keyof CopilotQuotaSnapshotEntry, true> = {
  fetchedAt: true,
  data: true,
};

const assertCopilotTokenEntry = (value: unknown, where: string): void => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError(`${where} must be a plain object`);
  }
  const obj = value as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    if (!Object.hasOwn(ALLOWED_TOKEN_KEYS_MAP, key)) {
      throw new TypeError(`${where} has unexpected key '${key}'`);
    }
  }
  if (typeof obj.token !== 'string' || obj.token === '') {
    throw new TypeError(`${where}.token must be a non-empty string`);
  }
  if (typeof obj.expiresAt !== 'number' || !Number.isFinite(obj.expiresAt)) {
    throw new TypeError(`${where}.expiresAt must be a finite number`);
  }
  if (typeof obj.baseUrl !== 'string' || obj.baseUrl === '') {
    throw new TypeError(`${where}.baseUrl must be a non-empty string`);
  }
};

const assertCopilotKnownModels = (value: unknown, where: string): void => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError(`${where} must be a plain object`);
  }
  const obj = value as Record<string, unknown>;
  if (typeof obj.fetchedAt !== 'number' || !Number.isFinite(obj.fetchedAt)) {
    throw new TypeError(`${where}.fetchedAt must be a finite number`);
  }
  if (typeof obj.models !== 'object' || obj.models === null || Array.isArray(obj.models)) {
    throw new TypeError(`${where}.models must be a plain object`);
  }
};

// Deeper validation of the snapshot's `data` payload lives in quota.ts, which
// owns the shape both sources project into. Here we only confirm the wrapper is
// a plain object so an unrelated value (array, scalar) doesn't slip past.
const assertCopilotQuotaSnapshotEntry = (value: unknown, where: string): void => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError(`${where} must be a plain object`);
  }
  const obj = value as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    if (!Object.hasOwn(ALLOWED_QUOTA_SNAPSHOT_KEYS_MAP, key)) {
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

export function assertCopilotUpstreamState(value: unknown): asserts value is CopilotUpstreamState {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('CopilotUpstreamState must be a plain object');
  }
  const obj = value as Record<string, unknown>;
  // state_json round-trips through canonical serialization, so any surviving
  // key is persisted. Reject unknown keys to keep the on-disk shape closed.
  for (const key of Object.keys(obj)) {
    if (!Object.hasOwn(ALLOWED_STATE_KEYS_MAP, key)) {
      throw new TypeError(`CopilotUpstreamState has unexpected key '${key}'`);
    }
  }
  if (obj.knownModels !== null && obj.knownModels !== undefined) {
    assertCopilotKnownModels(obj.knownModels, 'CopilotUpstreamState.knownModels');
  }
  if (obj.copilotToken !== null && obj.copilotToken !== undefined) {
    assertCopilotTokenEntry(obj.copilotToken, 'CopilotUpstreamState.copilotToken');
  }
  if (obj.quotaSnapshot !== null && obj.quotaSnapshot !== undefined) {
    assertCopilotQuotaSnapshotEntry(obj.quotaSnapshot, 'CopilotUpstreamState.quotaSnapshot');
  }
}

export const emptyCopilotUpstreamState = (): CopilotUpstreamState => ({
  knownModels: null,
  copilotToken: null,
  quotaSnapshot: null,
});

export const readCopilotUpstreamState = (raw: unknown): CopilotUpstreamState => {
  if (raw === null || raw === undefined) return emptyCopilotUpstreamState();
  assertCopilotUpstreamState(raw);
  return {
    knownModels: raw.knownModels ?? null,
    copilotToken: raw.copilotToken ?? null,
    quotaSnapshot: raw.quotaSnapshot ?? null,
  };
};
