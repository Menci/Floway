import type { UpstreamRecord } from '@floway-dev/provider';

// One Codex account's operator-managed identity, derived from the id_token at
// import. Mutating credentials (refresh_token, access_token, credential
// health) live in CodexUpstreamState instead.
export interface CodexAccountIdentity {
  email: string;
  chatgptAccountId: string;
  chatgptUserId: string;
  planType: string;
}

// Codex config is an account pool. v1 always carries exactly one entry —
// typed as a 1-tuple so callers can index accounts[0] without a nullable
// cushion. The wire shape stays array-of-accounts so a future fan-out /
// round-robin pool feature can widen the tuple without a schema migration;
// ordering is operator-controlled and stable.
export interface CodexUpstreamConfig {
  accounts: [CodexAccountIdentity];
}

export type CodexUpstreamRecord = UpstreamRecord & {
  kind: 'codex';
  config: CodexUpstreamConfig;
};

function assertCodexUpstreamConfig(value: unknown): asserts value is CodexUpstreamConfig {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('CodexUpstreamConfig must be a plain object');
  }
  const obj = value as Record<string, unknown>;
  // config_json round-trips through canonical serialization, so any surviving
  // key is persisted. Reject unknown keys to keep the on-disk shape closed.
  for (const key of Object.keys(obj)) {
    if (key !== 'accounts') {
      throw new TypeError(`CodexUpstreamConfig has unexpected key '${key}'`);
    }
  }
  if (!Array.isArray(obj.accounts)) {
    throw new TypeError('CodexUpstreamConfig.accounts must be an array');
  }
  if (obj.accounts.length !== 1) {
    throw new TypeError(`CodexUpstreamConfig.accounts must hold exactly one account (got ${obj.accounts.length})`);
  }
  const identityKeys: readonly (keyof CodexAccountIdentity)[] = ['email', 'chatgptAccountId', 'chatgptUserId', 'planType'];
  const allowedKeys = new Set<string>(identityKeys);
  for (let i = 0; i < obj.accounts.length; i++) {
    const where = `CodexUpstreamConfig.accounts[${i}]`;
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

export function assertCodexUpstreamRecord(record: UpstreamRecord): asserts record is CodexUpstreamRecord {
  if (record.kind !== 'codex') {
    throw new TypeError(`Expected provider 'codex', got '${record.kind}'`);
  }
  assertCodexUpstreamConfig(record.config);
}
