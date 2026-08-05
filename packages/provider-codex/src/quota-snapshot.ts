export interface CodexQuotaSnapshot {
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

const QUOTA_SNAPSHOT_KEYS: ReadonlySet<keyof CodexQuotaSnapshot> = new Set([
  'observed_at',
  'active_limit',
  'plan_type',
  'primary_used_percent',
  'primary_window_minutes',
  'primary_reset_after_at',
  'secondary_used_percent',
  'secondary_window_minutes',
  'secondary_reset_after_at',
  'credits_has_credits',
  'credits_balance',
  'ratelimited_until',
]);

const OPTIONAL_STRINGS: readonly (keyof CodexQuotaSnapshot)[] = ['active_limit', 'plan_type'];
const OPTIONAL_NUMBERS: readonly (keyof CodexQuotaSnapshot)[] = [
  'primary_used_percent',
  'primary_window_minutes',
  'secondary_used_percent',
  'secondary_window_minutes',
  'credits_balance',
];
const OPTIONAL_TIMESTAMPS: readonly (keyof CodexQuotaSnapshot)[] = [
  'primary_reset_after_at',
  'secondary_reset_after_at',
  'ratelimited_until',
];

const isRepresentableTimestamp = (value: string): boolean => !Number.isNaN(new Date(value).getTime());

export function assertCodexQuotaSnapshot(value: unknown, where: string): asserts value is CodexQuotaSnapshot {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError(`${where} must be a plain object`);
  }
  const snapshot = value as Record<string, unknown>;
  for (const key of Object.keys(snapshot)) {
    if (!QUOTA_SNAPSHOT_KEYS.has(key as keyof CodexQuotaSnapshot)) {
      throw new TypeError(`${where} has unexpected key '${key}'`);
    }
  }
  if (typeof snapshot.observed_at !== 'string' || !isRepresentableTimestamp(snapshot.observed_at)) {
    throw new TypeError(`${where}.observed_at must be a representable timestamp`);
  }
  for (const key of OPTIONAL_STRINGS) {
    const field = snapshot[key];
    if (field !== undefined && (typeof field !== 'string' || field === '')) {
      throw new TypeError(`${where}.${key} must be a non-empty string when present`);
    }
  }
  for (const key of OPTIONAL_NUMBERS) {
    const field = snapshot[key];
    if (field !== undefined && (typeof field !== 'number' || !Number.isFinite(field))) {
      throw new TypeError(`${where}.${key} must be a finite number when present`);
    }
  }
  if (snapshot.credits_has_credits !== undefined && typeof snapshot.credits_has_credits !== 'boolean') {
    throw new TypeError(`${where}.credits_has_credits must be boolean when present`);
  }
  for (const key of OPTIONAL_TIMESTAMPS) {
    const field = snapshot[key];
    if (field !== undefined && (typeof field !== 'string' || !isRepresentableTimestamp(field))) {
      throw new TypeError(`${where}.${key} must be a representable timestamp when present`);
    }
  }
}
