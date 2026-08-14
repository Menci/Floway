import type { CodexUpstreamConfig } from '../config.ts';
import type { CodexUpstreamState } from '../state.ts';
import { normalizeCodexCredential, type CodexCredentialInput, type NormalizedCodexCredential } from './credential.ts';
import { exchangeCodexAuthorizationCode } from './oauth.ts';
import { isObject, optionalString, requireObject, requireString } from './parse-helpers.ts';
import type { Fetcher } from '@floway-dev/provider';

export interface CodexImportResult {
  config: CodexUpstreamConfig;
  state: CodexUpstreamState;
}

export interface CodexManualImportInput {
  access_token: string;
  refresh_token?: string | null;
  id_token?: string | null;
  account_id?: string | null;
  email?: string | null;
  plan_type?: string | null;
  expires_at?: number | string | null;
}

// What the dashboard shows before the operator commits to one account. It
// carries identity and lifecycle only — never credential material, because
// this crosses the wire to a browser purely so a human can pick a row.
export interface CodexJsonPreviewCandidate {
  sourceIndex: number;
  name: string | null;
  email: string | null;
  chatgptAccountId: string | null;
  chatgptUserId: string | null;
  planType: string | null;
  renewable: boolean;
  expiresAt: number | null;
  issues: string[];
}

const buildCodexImportResult = (credential: NormalizedCodexCredential, now: string): CodexImportResult => ({
  config: { accounts: [credential.identity] },
  state: {
    accounts: [{
      chatgptAccountId: credential.identity.chatgptAccountId,
      refresh_token: credential.refreshToken,
      state: 'active',
      state_updated_at: now,
      // Mint a fresh per-account installation id at import time. Codex CLI's
      // `$CODEX_HOME/installation_id` is a UUIDv4 written once per device and
      // reused forever; we mirror the shape and lifetime per Floway-managed
      // account so each account looks like one persisted Codex install rather
      // than a fingerprint that rotates per call.
      openaiDeviceId: crypto.randomUUID(),
      accessToken: {
        token: credential.accessToken,
        expiresAt: credential.expiresAt,
        refreshedAt: now,
        // Seed the entry with the import-time plan observation so refresh
        // flows whose id_token omits the claim still have one to preserve.
        // An unknown plan (null identity) stays absent rather than `null`,
        // because the entry's plan slot is a present-or-absent observation.
        ...(credential.identity.planType === null ? {} : { planType: credential.identity.planType, planObservedAt: now }),
      },
      quotaSnapshot: null,
    }],
  },
});

// Hand-typed fields. Only the bearer is required; everything else either fills
// a gap the tokens cannot answer or overrides a claim the operator knows to be
// stale.
export const importCodexFromManual = async (input: CodexManualImportInput): Promise<CodexImportResult> => {
  const credential = normalizeCodexCredential({
    accessToken: input.access_token,
    refreshToken: input.refresh_token,
    idToken: input.id_token,
    chatgptAccountId: input.account_id,
    email: input.email,
    planType: input.plan_type,
    expiresAt: parseSourceExpiry(input.expires_at, 'manual expires_at'),
  });
  return buildCodexImportResult(credential, new Date().toISOString());
};

// Exchange the authorization code for tokens, then read identity off the
// returned id_token. The PKCE verifier was generated and held by the dashboard
// alongside the round-tripped state, but only the verifier is passed to
// auth.openai.com (the endpoint rejects state with 400). The token exchange is
// the only network hop on this path, so `fetcher` is where the caller picks
// egress for the whole import.
export const importCodexFromCallback = async (opts: { code: string; codeVerifier: string; fetcher: Fetcher }): Promise<CodexImportResult> => {
  const tokens = await exchangeCodexAuthorizationCode({ code: opts.code, codeVerifier: opts.codeVerifier, fetcher: opts.fetcher });
  const credential = normalizeCodexCredential({
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    idToken: tokens.id_token,
    expiresAt: Date.now() + tokens.expires_in * 1000,
  });
  return buildCodexImportResult(credential, new Date().toISOString());
};

// Lists what a pasted document holds without committing to any of it, so the
// operator sees which account they are about to import. A row that fails to
// parse is reported with its reason rather than dropped, so a document that
// looks right but is not says why; a row for another provider is dropped,
// because it was never a candidate here.
export const previewCodexJson = async (rawJson: string): Promise<CodexJsonPreviewCandidate[]> =>
  parseCodexJsonSources(rawJson).flatMap<CodexJsonPreviewCandidate>(source => {
    if (!source.supported) return [];
    try {
      const credential = source.normalize();
      return [{
        sourceIndex: source.sourceIndex,
        name: source.name,
        email: credential.identity.email,
        chatgptAccountId: credential.identity.chatgptAccountId,
        chatgptUserId: credential.identity.chatgptUserId,
        planType: credential.identity.planType,
        renewable: credential.refreshToken !== null,
        expiresAt: credential.expiresAt,
        issues: [],
      }];
    } catch (error) {
      return [{
        sourceIndex: source.sourceIndex,
        name: source.name,
        email: null,
        chatgptAccountId: null,
        chatgptUserId: null,
        planType: null,
        renewable: false,
        expiresAt: null,
        issues: [error instanceof Error ? error.message : 'The account could not be parsed'],
      }];
    }
  });

export const importCodexFromJson = async (rawJson: string, sourceIndex: number): Promise<CodexImportResult> => {
  if (!Number.isInteger(sourceIndex) || sourceIndex < 0) throw new TypeError('Codex JSON source index must be a non-negative integer');
  const source = parseCodexJsonSources(rawJson).find(candidate => candidate.sourceIndex === sourceIndex);
  if (!source) throw new Error(`Codex JSON source index ${sourceIndex} does not exist`);
  if (!source.supported) throw new Error(`Codex JSON source index ${sourceIndex} is not an OpenAI OAuth account`);
  return buildCodexImportResult(source.normalize(), new Date().toISOString());
};

// One account the pasted document describes. `normalize` stays lazy so the
// preview can report a parse failure per row instead of failing the document.
interface CodexJsonSource {
  sourceIndex: number;
  name: string | null;
  supported: boolean;
  normalize: () => NormalizedCodexCredential;
}

// The envelopes accounts are exported in differ in nesting and in how they
// type an expiry:
// https://github.com/starmiaoa/chatgpt-register-k12/blob/main/chatgpt_register_k12/export/sub2api.py
// https://github.com/cnlimiter/codex-manager/blob/master/src/core/upload/sub2api_upload.py
// https://github.com/wm1634208243/CPA-SUB2_CONV/blob/main/examples/sub2.sample.json
//
// Detection is by envelope key rather than by asking the operator which format
// they hold. Two envelopes in one document is refused rather than ranked: the
// document was assembled by something we do not know, and importing the wrong
// half is worse than asking for a cleaner paste.
const parseCodexJsonSources = (rawJson: string): CodexJsonSource[] => {
  const root = parseJsonObject(rawJson, 'Codex credential JSON');
  const data = root.data;
  const matchers: Array<() => CodexJsonSource[]> = [];

  if (Object.hasOwn(root, 'tokens')) {
    matchers.push(() => [{
      sourceIndex: 0,
      name: null,
      supported: true,
      normalize: () => normalizeAuthJsonRoot(root),
    }]);
  }
  if (Object.hasOwn(root, 'credentials')) {
    matchers.push(() => [makeAccountSource(root, 0, 'Codex JSON root')]);
  }
  if (Object.hasOwn(root, 'accounts')) {
    matchers.push(() => parseAccountSources(root.accounts, 'Codex JSON accounts'));
  }
  if (isObject(data) && Object.hasOwn(data, 'accounts')) {
    matchers.push(() => parseAccountSources(data.accounts, 'Codex JSON data.accounts'));
  }

  if (matchers.length === 0) throw new TypeError('Codex credential JSON does not match a supported structure');
  if (matchers.length > 1) throw new Error('Codex credential JSON is ambiguous: multiple supported structures are present');
  return matchers[0]();
};

// `~/.codex/auth.json`: the CLI's own on-disk format, tokens under `.tokens`.
const normalizeAuthJsonRoot = (root: Record<string, unknown>): NormalizedCodexCredential => {
  const tokens = requireObject(root.tokens, 'Codex auth JSON tokens');
  return normalizeCodexCredential({
    accessToken: requireString(tokens.access_token, 'Codex auth JSON tokens.access_token'),
    refreshToken: optionalString(tokens.refresh_token, 'Codex auth JSON tokens.refresh_token'),
    idToken: optionalString(tokens.id_token, 'Codex auth JSON tokens.id_token'),
    chatgptAccountId: optionalString(tokens.account_id ?? root.account_id, 'Codex auth JSON account_id'),
    expiresAt: parseSourceExpiry(tokens.expires_at, 'Codex auth JSON tokens.expires_at'),
  });
};

const parseAccountSources = (value: unknown, where: string): CodexJsonSource[] => {
  if (!Array.isArray(value)) throw new TypeError(`${where} must be an array`);
  return value.map((entry, sourceIndex) => makeAccountSource(
    requireObject(entry, `${where}[${sourceIndex}]`),
    sourceIndex,
    `${where}[${sourceIndex}]`,
  ));
};

const makeAccountSource = (account: Record<string, unknown>, sourceIndex: number, where: string): CodexJsonSource => ({
  sourceIndex,
  // A label, not a credential field. A document that types it as something
  // else still imports; the row just falls back to another label.
  name: typeof account.name === 'string' && account.name !== '' ? account.name : null,
  supported: isSupportedAccount(account),
  normalize: () => normalizeAccountRecord(account, where),
});

const normalizeAccountRecord = (account: Record<string, unknown>, where: string): NormalizedCodexCredential => {
  const credentials = requireObject(account.credentials, `${where}.credentials`);
  const input: CodexCredentialInput = {
    accessToken: requireString(credentials.access_token, `${where}.credentials.access_token`),
    refreshToken: optionalString(credentials.refresh_token, `${where}.credentials.refresh_token`),
    idToken: optionalString(credentials.id_token, `${where}.credentials.id_token`),
    chatgptAccountId: optionalString(credentials.chatgpt_account_id ?? credentials.account_id, `${where}.credentials.chatgpt_account_id`),
    email: optionalString(credentials.email, `${where}.credentials.email`),
    chatgptUserId: optionalString(credentials.chatgpt_user_id, `${where}.credentials.chatgpt_user_id`),
    planType: optionalString(credentials.plan_type, `${where}.credentials.plan_type`),
    expiresAt: parseSourceExpiry(credentials.expires_at, `${where}.credentials.expires_at`),
  };
  return normalizeCodexCredential(input);
};

// Multi-provider exports tag each account. An untagged account is taken as
// ours, because the single-provider exports carry no tag at all.
const isSupportedAccount = (account: Record<string, unknown>): boolean => {
  const platform = account.platform;
  const type = account.type;
  const platformSupported = platform === undefined || (typeof platform === 'string' && platform.toLowerCase() === 'openai');
  const typeSupported = type === undefined || (typeof type === 'string' && type.toLowerCase() === 'oauth');
  return platformSupported && typeSupported;
};

// Exporters variously write unix seconds as a number or a string, an ISO
// timestamp, or a zero standing for "never set". Zero reads as unknown rather
// than as 1970, so an access-only credential imported from such a file is
// usable until the upstream says otherwise instead of arriving pre-expired.
export const parseSourceExpiry = (value: unknown, where = 'expires_at'): number | null => {
  if (value === undefined || value === null || value === '' || value === 0 || value === '0') return null;
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value < 0) throw new TypeError(`${where} must be a unix-seconds number or ISO 8601 string`);
    return value * 1000;
  }
  if (typeof value !== 'string') throw new TypeError(`${where} must be a unix-seconds number or ISO 8601 string`);
  if (/^\d+$/.test(value)) {
    const seconds = Number(value);
    if (!Number.isFinite(seconds)) throw new TypeError(`${where} must be a finite unix-seconds value`);
    return seconds * 1000;
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new TypeError(`${where} must be a unix-seconds number or ISO 8601 string`);
  return parsed;
};

const parseJsonObject = (rawJson: string, label: string): Record<string, unknown> => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
  } catch (cause) {
    throw new Error(`${label} is not valid JSON`, { cause: cause as Error });
  }
  return requireObject(parsed, `${label} root`);
};
