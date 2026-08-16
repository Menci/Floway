import { assertAllowedObjectKeys } from './auth/parse-helpers.ts';
import type { UpstreamRecord } from '@floway-dev/provider';

// One Codex account's operator-managed identity, derived from explicit import
// fields and whatever claims the supplied tokens happen to carry. Mutating
// credentials (refresh_token, access_token, credential health) live in
// CodexUpstreamState instead.
//
// Every field is nullable because an import source may know none of them: an
// opaque access token carries no claims, and an operator holding only a bearer
// has nothing else to type in. `null` is the recorded absence — the field is
// always present in the persisted document, never omitted.
export interface CodexAccountIdentity {
  email: string | null;
  chatgptAccountId: string | null;
  chatgptUserId: string | null;
  planType: string | null;
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

const IDENTITY_KEYS: readonly (keyof CodexAccountIdentity)[] = ['email', 'chatgptAccountId', 'chatgptUserId', 'planType'];

// Allowlists for the shared shape guard: the config document's only key is
// `accounts`, while each account may carry any of the identity fields.
const CONFIG_KEYS_SET: ReadonlySet<string> = new Set(['accounts']);
const IDENTITY_KEYS_SET: ReadonlySet<string> = new Set(IDENTITY_KEYS);

// An absent value is written as an explicit `null`, so a missing key and an
// empty string both stay rejected — the document says what it knows and what
// it does not, and never leaves the reader guessing which.
function assertIdentityValue(value: unknown, where: string): asserts value is string | null {
  if (value !== null && (typeof value !== 'string' || value === '')) {
    throw new TypeError(`${where} must be a non-empty string or null`);
  }
}

// The generic upstream PATCH may correct display metadata an import could not
// infer, but `chatgptAccountId` is the join key between config and state, so
// changing it would orphan the stored credential. It may only be restated as
// what it already is; moving to a different account means re-importing.
export const patchCodexIdentityMetadata = (
  current: CodexUpstreamConfig,
  patch: Record<string, unknown>,
): CodexUpstreamConfig => {
  for (const key of Object.keys(patch)) {
    if (key !== 'accounts') throw new TypeError(`Codex config metadata patch has unexpected key '${key}'`);
  }
  if (patch.accounts === undefined) return current;
  if (!Array.isArray(patch.accounts) || patch.accounts.length !== 1) {
    throw new TypeError('Codex config metadata patch accounts must hold exactly one account');
  }
  const rawAccount = patch.accounts[0];
  if (typeof rawAccount !== 'object' || rawAccount === null || Array.isArray(rawAccount)) {
    throw new TypeError('Codex config metadata patch account must be a plain object');
  }
  const accountPatch = rawAccount as Record<string, unknown>;
  for (const key of Object.keys(accountPatch)) {
    if (!IDENTITY_KEYS_SET.has(key)) throw new TypeError(`Codex config metadata patch account has unexpected key '${key}'`);
  }
  if (accountPatch.chatgptAccountId !== undefined) {
    assertIdentityValue(accountPatch.chatgptAccountId, 'Codex config metadata patch chatgptAccountId');
    if (accountPatch.chatgptAccountId !== current.accounts[0].chatgptAccountId) {
      throw new TypeError('Codex ChatGPT account ID can only be changed by re-importing credentials');
    }
  }

  const next = { ...current.accounts[0] };
  for (const key of ['email', 'chatgptUserId', 'planType'] as const) {
    const value = accountPatch[key];
    if (value === undefined) continue;
    assertIdentityValue(value, `Codex config metadata patch ${key}`);
    next[key] = value;
  }
  return { accounts: [next] };
};

function assertCodexUpstreamConfig(value: unknown): asserts value is CodexUpstreamConfig {
  // config_json round-trips through canonical serialization, so any surviving
  // key is persisted. Reject unknown keys to keep the on-disk shape closed.
  const obj = assertAllowedObjectKeys(value, 'CodexUpstreamConfig', CONFIG_KEYS_SET);
  if (!Array.isArray(obj.accounts)) {
    throw new TypeError('CodexUpstreamConfig.accounts must be an array');
  }
  if (obj.accounts.length !== 1) {
    throw new TypeError(`CodexUpstreamConfig.accounts must hold exactly one account (got ${obj.accounts.length})`);
  }
  for (let i = 0; i < obj.accounts.length; i++) {
    const where = `CodexUpstreamConfig.accounts[${i}]`;
    const acc = assertAllowedObjectKeys(obj.accounts[i], where, IDENTITY_KEYS_SET);
    for (const key of IDENTITY_KEYS) {
      assertIdentityValue(acc[key], `${where}.${key}`);
    }
  }
}

export function assertCodexUpstreamRecord(record: UpstreamRecord): asserts record is CodexUpstreamRecord {
  if (record.kind !== 'codex') {
    throw new TypeError(`Expected provider 'codex', got '${record.kind}'`);
  }
  assertCodexUpstreamConfig(record.config);
}
