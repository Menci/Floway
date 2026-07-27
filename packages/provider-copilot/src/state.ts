// Gateway-managed Copilot upstream state, persisted in upstreams.state_json.
// Writes happen via UpstreamRepo.saveState with optimistic concurrency keyed
// on the prior state JSON.

import type { CopilotKnownModels } from './known-models.ts';

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

export interface CopilotUpstreamState {
  knownModels: CopilotKnownModels | null;
  copilotToken: CopilotTokenEntry | null;
}

const ALLOWED_STATE_KEYS_MAP: Record<keyof CopilotUpstreamState, true> = {
  knownModels: true,
  copilotToken: true,
};

const ALLOWED_TOKEN_KEYS_MAP: Record<keyof CopilotTokenEntry, true> = {
  token: true,
  expiresAt: true,
  baseUrl: true,
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
}

export const emptyCopilotUpstreamState = (): CopilotUpstreamState => ({
  knownModels: null,
  copilotToken: null,
});

export const readCopilotUpstreamState = (raw: unknown): CopilotUpstreamState => {
  if (raw === null || raw === undefined) return emptyCopilotUpstreamState();
  assertCopilotUpstreamState(raw);
  return {
    knownModels: raw.knownModels ?? null,
    copilotToken: raw.copilotToken ?? null,
  };
};
