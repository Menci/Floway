import { readOllamaAccountUsage, type OllamaUsageData } from './account-usage.ts';

// The probe's outcome, kept as three fields rather than one nullable snapshot
// because the data-plane trigger needs all three:
//
// - `attemptedAt` (unix ms) anchors the debounce. It advances on failures too,
//   so an upstream whose probe is failing is retried on the same cadence as one
//   that succeeds instead of re-probing on every request.
// - `observation` is the last successful read, kept across later failures: a
//   usage window measured in hours stays informative while a transient upstream
//   failure resolves, and the dashboard renders its age from `fetchedAt`.
// - `error` carries the most recent failure and is cleared by the next success,
//   so a probe that has silently stopped working is visible to the operator
//   rather than showing as an indefinitely fresh-looking card.
export interface OllamaUsageProbeEntry {
  attemptedAt: number;
  observation: OllamaUsageObservation | null;
  error: string | null;
}

// Persist both usage history and current balance bodies verbatim. The dashboard
// selects the fields appropriate to the account's plan; `fetchedAt` is unix ms.
// https://github.com/ollama/ollama/blob/eab97e9f92b9a25c2d52d2cc6c1b1c99bd9fae21/docs/api/balance.mdx
// https://github.com/ollama/ollama/blob/eab97e9f92b9a25c2d52d2cc6c1b1c99bd9fae21/docs/api/cloud-usage.mdx
export interface OllamaUsageObservation {
  fetchedAt: number;
  data: OllamaUsageData;
}

// The account behind the API key. It sits in its own slot rather than inside
// the usage observation because it moves on a different clock: a subscription
// changes on a billing boundary at most, while the windows move with traffic.
//
// Identity is kept to what the dashboard names the account by. `plan` is null
// when the account reported none — the emptiness is the upstream's answer, not
// a stand-in for the free tier.
export interface OllamaAccountEntry {
  fetchedAt: number;
  plan: string | null;
  name: string | null;
  email: string | null;
}

export interface OllamaUpstreamState {
  usageProbe: OllamaUsageProbeEntry | null;
  account: OllamaAccountEntry | null;
}

const ALLOWED_STATE_KEYS_MAP: Record<keyof OllamaUpstreamState, true> = {
  usageProbe: true,
  account: true,
};

const ALLOWED_ACCOUNT_KEYS_MAP: Record<keyof OllamaAccountEntry, true> = {
  fetchedAt: true,
  plan: true,
  name: true,
  email: true,
};

const ALLOWED_PROBE_KEYS_MAP: Record<keyof OllamaUsageProbeEntry, true> = {
  attemptedAt: true,
  observation: true,
  error: true,
};

const ALLOWED_OBSERVATION_KEYS_MAP: Record<keyof OllamaUsageObservation, true> = {
  fetchedAt: true,
  data: true,
};

const assertClosedObject = (value: unknown, where: string, allowed: Record<string, true>): Record<string, unknown> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError(`${where} must be a plain object`);
  }
  const obj = value as Record<string, unknown>;
  // state_json round-trips through canonical serialization, so any surviving
  // key is persisted. Reject unknown keys to keep the on-disk shape closed.
  for (const key of Object.keys(obj)) {
    if (!Object.hasOwn(allowed, key)) throw new TypeError(`${where} has unexpected key '${key}'`);
  }
  return obj;
};

const assertUnixMs = (value: unknown, where: string): void => {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TypeError(`${where} must be a finite number`);
  }
};

const assertOllamaUsageObservation = (value: unknown, where: string): void => {
  const obj = assertClosedObject(value, where, ALLOWED_OBSERVATION_KEYS_MAP);
  assertUnixMs(obj.fetchedAt, `${where}.fetchedAt`);
  readOllamaAccountUsage(obj.data);
};

const assertOptionalString = (value: unknown, where: string): void => {
  if (value !== null && value !== undefined && typeof value !== 'string') {
    throw new TypeError(`${where} must be a string`);
  }
};

const assertOllamaAccountEntry = (value: unknown, where: string): void => {
  const obj = assertClosedObject(value, where, ALLOWED_ACCOUNT_KEYS_MAP);
  assertUnixMs(obj.fetchedAt, `${where}.fetchedAt`);
  assertOptionalString(obj.plan, `${where}.plan`);
  assertOptionalString(obj.name, `${where}.name`);
  assertOptionalString(obj.email, `${where}.email`);
};

const assertOllamaUsageProbeEntry = (value: unknown, where: string): void => {
  const obj = assertClosedObject(value, where, ALLOWED_PROBE_KEYS_MAP);
  assertUnixMs(obj.attemptedAt, `${where}.attemptedAt`);
  if (obj.observation !== null && obj.observation !== undefined) {
    assertOllamaUsageObservation(obj.observation, `${where}.observation`);
  }
  assertOptionalString(obj.error, `${where}.error`);
};

export function assertOllamaUpstreamState(value: unknown): asserts value is OllamaUpstreamState {
  const obj = assertClosedObject(value, 'OllamaUpstreamState', ALLOWED_STATE_KEYS_MAP);
  if (obj.usageProbe !== null && obj.usageProbe !== undefined) {
    assertOllamaUsageProbeEntry(obj.usageProbe, 'OllamaUpstreamState.usageProbe');
  }
  if (obj.account !== null && obj.account !== undefined) {
    assertOllamaAccountEntry(obj.account, 'OllamaUpstreamState.account');
  }
}

export const emptyOllamaUpstreamState = (): OllamaUpstreamState => ({ usageProbe: null, account: null });

// The asserter treats an absent optional key as null, so the entry is rebuilt
// here rather than passed through: readers get the three fields the type
// promises instead of `undefined` behind a `| null`.
export const readOllamaUpstreamState = (raw: unknown): OllamaUpstreamState => {
  if (raw === null || raw === undefined) return emptyOllamaUpstreamState();
  assertOllamaUpstreamState(raw);
  const probe = raw.usageProbe;
  const account = raw.account;
  return {
    usageProbe: probe
      ? { attemptedAt: probe.attemptedAt, observation: probe.observation ?? null, error: probe.error ?? null }
      : null,
    account: account
      ? { fetchedAt: account.fetchedAt, plan: account.plan ?? null, name: account.name ?? null, email: account.email ?? null }
      : null,
  };
};
