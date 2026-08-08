// Gateway-managed Ollama upstream state, persisted in upstreams.state_json.
// Two slots, both Ollama Cloud account facts on their own refresh cadence: the
// most recent usage probe, and the account the API key belongs to. Writes go
// through
// UpstreamRepo.saveState as a mutator that spreads the state it is handed and
// replaces its own slot, so a concurrent write on another slot survives.

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

// `data` is the upstream body verbatim. Ollama serves the usage endpoint
// undocumented (docs.ollama.com covers /api/usage as per-response performance
// metrics, not account quota) and has already changed its per-model field
// naming once, so the gateway stores what it received and lets the dashboard
// walk the keys it knows. `fetchedAt` is unix ms.
export interface OllamaUsageObservation {
  fetchedAt: number;
  data: unknown;
}

// The account behind the API key. `plan` is Ollama's own identifier, kept as
// the open string it is; null when the account named none. There is no error
// field beside it: a plan the probe could not read costs the dashboard a name
// and nothing an operator would act on, so the slot simply stays as it was.
export interface OllamaAccountEntry {
  fetchedAt: number;
  plan: string | null;
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
  // The body's inner shape is upstream-owned; confirming it is a plain object
  // is the whole contract the dashboard relies on.
  if (typeof obj.data !== 'object' || obj.data === null || Array.isArray(obj.data)) {
    throw new TypeError(`${where}.data must be a plain object`);
  }
};

const assertOllamaUsageProbeEntry = (value: unknown, where: string): void => {
  const obj = assertClosedObject(value, where, ALLOWED_PROBE_KEYS_MAP);
  assertUnixMs(obj.attemptedAt, `${where}.attemptedAt`);
  if (obj.observation !== null && obj.observation !== undefined) {
    assertOllamaUsageObservation(obj.observation, `${where}.observation`);
  }
  if (obj.error !== null && obj.error !== undefined && typeof obj.error !== 'string') {
    throw new TypeError(`${where}.error must be a string`);
  }
};

const assertOllamaAccountEntry = (value: unknown, where: string): void => {
  const obj = assertClosedObject(value, where, ALLOWED_ACCOUNT_KEYS_MAP);
  assertUnixMs(obj.fetchedAt, `${where}.fetchedAt`);
  if (obj.plan !== null && obj.plan !== undefined && typeof obj.plan !== 'string') {
    throw new TypeError(`${where}.plan must be a string`);
  }
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
      ? {
          attemptedAt: probe.attemptedAt,
          observation: probe.observation ?? null,
          error: probe.error ?? null,
        }
      : null,
    account: account ? { fetchedAt: account.fetchedAt, plan: account.plan ?? null } : null,
  };
};
