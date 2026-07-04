import type { UpstreamRecord } from '@floway-dev/provider';

// One Cursor account's operator-managed identity, derived from the access
// token JWT at import. Mutating credentials (refresh_token, access_token,
// credential health) live in CursorUpstreamState instead.
export interface CursorAccountIdentity {
  email: string;
  userId: string;
}

// Cursor config is an account pool. v1 always carries exactly one entry —
// typed as a 1-tuple so callers can index accounts[0] without a nullable
// cushion. The wire shape stays array-of-accounts so a future fan-out /
// round-robin pool feature can widen the tuple without a schema migration.
export interface CursorUpstreamConfig {
  accounts: [CursorAccountIdentity];
  // Operator toggle: send every request in Cursor Max Mode (larger context
  // window, higher usage cost). Absent/false = normal mode. Persisted via
  // PATCH /api/upstreams/:id { config: { maxMode } } — the accounts pool is
  // owned by the import/re-import endpoints and never touched by that patch.
  maxMode?: boolean;
  // Operator toggle: expose Cursor Tab (StreamCpp) as an OpenAI /v1/completions
  // edit-prediction model. `model` is the cpp model name sent upstream
  // (default "fast"). Same settings-only PATCH path as maxMode.
  tabCompletion?: {
    enabled: boolean;
    model?: string;
  };
  // Privacy / ghost mode toggle sent to Cursor as the x-ghost-mode data-plane
  // header. Absent = default on (privacy preserved) — see provider.ts, which
  // resolves `privacyMode ?? true`. Only the chat data plane honors this; the
  // model-catalog fetch stays always-private (no user content flows there).
  privacyMode?: boolean;
}

export type CursorUpstreamRecord = UpstreamRecord & {
  provider: 'cursor';
  config: CursorUpstreamConfig;
};

function assertCursorUpstreamConfig(value: unknown): asserts value is CursorUpstreamConfig {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('CursorUpstreamConfig must be a plain object');
  }
  const obj = value as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    if (key !== 'accounts' && key !== 'maxMode' && key !== 'tabCompletion' && key !== 'privacyMode') {
      throw new TypeError(`CursorUpstreamConfig has unexpected key '${key}'`);
    }
  }
  if (obj.maxMode !== undefined && typeof obj.maxMode !== 'boolean') {
    throw new TypeError('CursorUpstreamConfig.maxMode must be a boolean');
  }
  if (obj.tabCompletion !== undefined) {
    const tc = obj.tabCompletion;
    if (typeof tc !== 'object' || tc === null || Array.isArray(tc)) {
      throw new TypeError('CursorUpstreamConfig.tabCompletion must be a plain object');
    }
    const tco = tc as Record<string, unknown>;
    for (const key of Object.keys(tco)) {
      if (key !== 'enabled' && key !== 'model') {
        throw new TypeError(`CursorUpstreamConfig.tabCompletion has unexpected key '${key}'`);
      }
    }
    if (typeof tco.enabled !== 'boolean') {
      throw new TypeError('CursorUpstreamConfig.tabCompletion.enabled must be a boolean');
    }
    if (tco.model !== undefined && (typeof tco.model !== 'string' || tco.model === '')) {
      throw new TypeError('CursorUpstreamConfig.tabCompletion.model must be a non-empty string');
    }
  }
  if (obj.privacyMode !== undefined && typeof obj.privacyMode !== 'boolean') {
    throw new TypeError('CursorUpstreamConfig.privacyMode must be a boolean when present');
  }
  if (!Array.isArray(obj.accounts)) {
    throw new TypeError('CursorUpstreamConfig.accounts must be an array');
  }
  if (obj.accounts.length !== 1) {
    throw new TypeError(`CursorUpstreamConfig.accounts must hold exactly one account (got ${obj.accounts.length})`);
  }
  const identityKeys: readonly (keyof CursorAccountIdentity)[] = ['email', 'userId'];
  const allowedKeys = new Set<string>(identityKeys);
  for (let i = 0; i < obj.accounts.length; i++) {
    const where = `CursorUpstreamConfig.accounts[${i}]`;
    const account = obj.accounts[i];
    if (typeof account !== 'object' || account === null || Array.isArray(account)) {
      throw new TypeError(`${where} must be a plain object`);
    }
    const acc = account as Record<string, unknown>;
    for (const key of Object.keys(acc)) {
      if (!allowedKeys.has(key)) {
        throw new TypeError(`${where} has unexpected key '${key}'`);
      }
    }
    for (const key of identityKeys) {
      const v = acc[key];
      if (typeof v !== 'string' || v === '') {
        throw new TypeError(`${where}.${key} must be a non-empty string`);
      }
    }
  }
}

export function assertCursorUpstreamRecord(record: UpstreamRecord): asserts record is CursorUpstreamRecord {
  if (record.kind !== 'cursor') {
    throw new TypeError(`Expected kind 'cursor', got '${record.kind}'`);
  }
  assertCursorUpstreamConfig(record.config);
}
