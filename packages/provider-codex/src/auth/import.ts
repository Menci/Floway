import type { CodexUpstreamConfig } from '../config.ts';
import type { CodexUpstreamState } from '../state.ts';
import type { CodexIdTokenIdentity } from './jwt.ts';
import { parseCodexIdTokenClaims } from './jwt.ts';
import { exchangeCodexAuthorizationCode } from './oauth.ts';
import type { Fetcher } from '@floway-dev/provider';

export interface CodexImportResult {
  config: CodexUpstreamConfig;
  state: CodexUpstreamState;
}

const buildCodexImportResult = (params: {
  identity: CodexIdTokenIdentity;
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  now: string;
}): CodexImportResult => ({
  config: {
    accounts: [{
      email: params.identity.email,
      chatgptAccountId: params.identity.chatgptAccountId,
      chatgptUserId: params.identity.chatgptUserId,
      planType: params.identity.planType,
    }],
  },
  state: {
    accounts: [{
      chatgptAccountId: params.identity.chatgptAccountId,
      refresh_token: params.refreshToken,
      state: 'active',
      state_updated_at: params.now,
      // Mint a fresh per-account installation id at import time. Codex CLI's
      // `$CODEX_HOME/installation_id` is a UUIDv4 written once per device and
      // reused forever; we mirror the shape and lifetime per Floway-managed
      // account so each account looks like one persisted Codex install rather
      // than a fingerprint that rotates per call.
      openaiDeviceId: crypto.randomUUID(),
      accessToken: {
        token: params.accessToken,
        expiresAt: params.expiresAt,
        refreshedAt: params.now,
      },
      quotaSnapshot: null,
    }],
  },
});

// Imports a verbatim ~/.codex/auth.json. The CLI's on-disk format wraps tokens
// under `.tokens`. We re-derive identity from id_token rather than trusting the
// file's account_id / email / plan, so this path produces the same shape as
// importCodexFromCallback (which only has the OAuth response to work from).
export const importCodexFromAuthJson = async (rawJson: string): Promise<CodexImportResult> => {
  const pickNonEmptyString = (record: Record<string, unknown>, key: string, prefix: string): string => {
    const value = record[key];
    if (typeof value !== 'string' || value === '') throw new TypeError(`${prefix}.${key} must be a non-empty string`);
    return value;
  };

  let authJson: unknown;
  try {
    authJson = JSON.parse(rawJson);
  } catch (cause) {
    throw new Error('auth.json is not valid JSON', { cause: cause as Error });
  }
  if (typeof authJson !== 'object' || authJson === null) throw new TypeError('auth.json must be a JSON object');
  const obj = authJson as Record<string, unknown>;
  const tokens = obj.tokens;
  if (typeof tokens !== 'object' || tokens === null) throw new TypeError('auth.json.tokens missing');
  const t = tokens as Record<string, unknown>;
  const accessToken = pickNonEmptyString(t, 'access_token', 'auth.json.tokens');
  const refreshToken = pickNonEmptyString(t, 'refresh_token', 'auth.json.tokens');
  const idToken = pickNonEmptyString(t, 'id_token', 'auth.json.tokens');

  const identity = parseCodexIdTokenClaims(idToken);
  // auth.json carries the access_token + refresh_token but no `expires_in`
  // for the access_token. Stamp a conservative 7-day fallback so the
  // freshness gate in access-token-cache forces a /oauth/token refresh on
  // the first data-plane call rather than handing out a token of unknown
  // remaining lifetime. The refresh_token's own lifetime is set by
  // auth.openai.com and is unaffected by this fallback.
  const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
  return buildCodexImportResult({
    identity,
    accessToken,
    refreshToken,
    expiresAt: Date.now() + sevenDaysMs,
    now: new Date().toISOString(),
  });
};

// Exchange the authorization code for tokens, then derive identity from the
// returned id_token. The PKCE verifier was generated and held by the
// dashboard alongside the round-tripped state, but only the verifier is
// passed to auth.openai.com (the endpoint rejects state with 400). The
// token exchange is the only network hop on this path (identity parses
// locally from the id_token), so `fetcher` is where the caller picks
// egress for the whole import.
export const importCodexFromCallback = async (opts: { code: string; codeVerifier: string; fetcher: Fetcher }): Promise<CodexImportResult> => {
  const tokens = await exchangeCodexAuthorizationCode({ code: opts.code, codeVerifier: opts.codeVerifier, fetcher: opts.fetcher });
  const identity = parseCodexIdTokenClaims(tokens.id_token);
  return buildCodexImportResult({
    identity,
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    expiresAt: Date.now() + tokens.expires_in * 1000,
    now: new Date().toISOString(),
  });
};
