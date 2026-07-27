import type { ClaudeCodeUpstreamConfig } from '../config.ts';
import type { ClaudeCodeAccountCredential, ClaudeCodeUpstreamState } from '../state.ts';
import { fetchClaudeCodeIdentity, type ClaudeCodeIdentity } from './identity.ts';
import { exchangeClaudeCodeAuthorizationCode } from './oauth.ts';
import { directFetcher, type Fetcher } from '@floway-dev/provider';

export interface ClaudeCodeImportResult {
  config: ClaudeCodeUpstreamConfig;
  state: ClaudeCodeUpstreamState;
}

type BuildImportResultParams = {
  identity: ClaudeCodeIdentity;
  accessToken: string;
  expiresAt: number;
  now: string;
} & ({ tokenKind: 'setup-token' } | { tokenKind: 'oauth'; refreshToken: string });

const buildClaudeCodeImportResult = (params: BuildImportResultParams): ClaudeCodeImportResult => {
  const accessTokenEntry = {
    token: params.accessToken,
    expiresAt: params.expiresAt,
    refreshedAt: params.now,
  };
  const credentialBase = {
    accountUuid: params.identity.accountUuid,
    state: 'active' as const,
    stateUpdatedAt: params.now,
    accessToken: accessTokenEntry,
    quotaSnapshot: null,
    usageProbeSnapshot: null,
  };
  const credential: ClaudeCodeAccountCredential = params.tokenKind === 'setup-token'
    ? { ...credentialBase, tokenKind: 'setup-token', refreshToken: null }
    : { ...credentialBase, tokenKind: 'oauth', refreshToken: params.refreshToken };
  return {
    config: {
      accounts: [{
        email: params.identity.email,
        accountUuid: params.identity.accountUuid,
        organizationUuid: params.identity.organizationUuid,
        subscriptionType: params.identity.subscriptionType,
        rateLimitTier: params.identity.rateLimitTier,
      }],
    },
    state: { accounts: [credential] },
  };
};

// Both calls (OAuth token exchange + /api/oauth/profile) run through the
// caller-supplied `fetcher`. The import flow runs before the upstream
// record exists, so the fetcher cannot be resolved from a persisted
// proxy_fallback_list — the control-plane import route builds it from the
// operator's in-flight form override and threads it in here. Pass
// `directFetcher` for direct egress.
export const importClaudeCodeFromCallback = async (opts: {
  code: string;
  pkceVerifier: string;
  state: string;
  fetcher: Fetcher;
}): Promise<ClaudeCodeImportResult> => {
  const tokens = await exchangeClaudeCodeAuthorizationCode({
    code: opts.code,
    codeVerifier: opts.pkceVerifier,
    state: opts.state,
    kind: 'oauth',
    fetcher: opts.fetcher,
  });
  if (typeof tokens.refresh_token !== 'string' || tokens.refresh_token === '') {
    throw new Error('Claude Code OAuth /token response missing refresh_token on full-scope exchange');
  }
  const identity = await fetchClaudeCodeIdentity(tokens.access_token, opts.fetcher);
  return buildClaudeCodeImportResult({
    identity,
    tokenKind: 'oauth',
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    expiresAt: Date.now() + tokens.expires_in * 1000,
    now: new Date().toISOString(),
  });
};

// Setup-Token PKCE flow. Same callback shape as the regular OAuth flow, but
// the authorize URL carried only `user:inference` scope and the exchange
// asks the upstream for a ~1 year access token. The response has no
// `refresh_token` — when this token expires the operator must re-import.
// The profile endpoint requires `user:profile`; since the bearer lacks
// that scope, `fetchClaudeCodeIdentity` falls back to a degraded identity
// (deterministic accountUuid + nulls for email / org / subscription).
export const importClaudeCodeFromSetupTokenCallback = async (opts: {
  code: string;
  pkceVerifier: string;
  state: string;
  fetcher: Fetcher;
}): Promise<ClaudeCodeImportResult> => {
  const tokens = await exchangeClaudeCodeAuthorizationCode({
    code: opts.code,
    codeVerifier: opts.pkceVerifier,
    state: opts.state,
    kind: 'setup-token',
    fetcher: opts.fetcher,
  });
  const identity = await fetchClaudeCodeIdentity(tokens.access_token, opts.fetcher);
  return buildClaudeCodeImportResult({
    identity,
    tokenKind: 'setup-token',
    accessToken: tokens.access_token,
    expiresAt: Date.now() + tokens.expires_in * 1000,
    now: new Date().toISOString(),
  });
};

const pickNonEmptyString = (record: Record<string, unknown>, key: string, prefix: string): string => {
  const value = record[key];
  if (typeof value !== 'string' || value === '') {
    throw new TypeError(`${prefix}.${key} must be a non-empty string`);
  }
  return value;
};

// Verbatim ~/.claude/.credentials.json paste. The CLI's on-disk format wraps
// tokens under `.claudeAiOauth` and stores `subscriptionType` ('pro' / 'max'
// / 'team' / 'enterprise') and `rateLimitTier`
// ('default_claude_max_5x' etc.) as separate sibling fields. The JSON does
// not carry email / account uuid, so we still call /api/oauth/profile to
// derive identity, but we honor the JSON's two persisted plan fields
// verbatim when present (the snapshot was the CLI's own; preferring it
// avoids a derivation drift if Anthropic's profile shape changes between
// CLI sign-in and dashboard import). The JSON's `accessToken` is reused
// for the cached entry so the first request in does not need a refresh
// round-trip — the file is effectively a fresh-enough snapshot of the
// live credential.
//
// `fetcher` is forwarded to the identity call so the control-plane import
// route can route through an operator-supplied proxy chain. Default direct.
export const importClaudeCodeFromCredentialsJson = async (
  rawJson: string,
  fetcher: Fetcher = directFetcher,
): Promise<ClaudeCodeImportResult> => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
  } catch (cause) {
    throw new Error('credentials.json is not valid JSON', { cause });
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new TypeError('credentials.json must be a JSON object');
  }
  const obj = parsed as Record<string, unknown>;
  const wrapper = obj.claudeAiOauth;
  if (typeof wrapper !== 'object' || wrapper === null || Array.isArray(wrapper)) {
    throw new TypeError('credentials.json missing `claudeAiOauth` object');
  }
  const w = wrapper as Record<string, unknown>;

  const accessToken = pickNonEmptyString(w, 'accessToken', 'credentials.json.claudeAiOauth');
  const refreshToken = pickNonEmptyString(w, 'refreshToken', 'credentials.json.claudeAiOauth');
  const expiresAtRaw = w.expiresAt;
  if (typeof expiresAtRaw !== 'number' || !Number.isFinite(expiresAtRaw)) {
    throw new TypeError('credentials.json.claudeAiOauth.expiresAt must be a finite number (unix ms)');
  }
  // expiresAt is unix milliseconds; reject obviously-too-small values (1e12 ≈ 2001-09-09) to catch a seconds-encoded regression early.
  if (expiresAtRaw < 1_000_000_000_000) {
    throw new TypeError('credentials.json.claudeAiOauth.expiresAt looks like seconds, expected milliseconds');
  }

  // CLI persists subscriptionType ('pro' | 'max' | 'team' | 'enterprise')
  // and rateLimitTier (raw 'default_claude_max_5x' etc.) as separate
  // sibling fields. Take both verbatim when present; unknown
  // subscriptionType values fall back to the derived one rather than
  // breaking ingest.
  const persistedSubscriptionType = (w.subscriptionType === 'pro' || w.subscriptionType === 'max' || w.subscriptionType === 'team' || w.subscriptionType === 'enterprise')
    ? w.subscriptionType
    : null;
  const persistedRateLimitTier = typeof w.rateLimitTier === 'string' && w.rateLimitTier !== ''
    ? w.rateLimitTier
    : null;

  const identity = await fetchClaudeCodeIdentity(accessToken, fetcher);
  const finalIdentity: ClaudeCodeIdentity = {
    ...identity,
    ...(persistedSubscriptionType !== null ? { subscriptionType: persistedSubscriptionType } : {}),
    ...(persistedRateLimitTier !== null ? { rateLimitTier: persistedRateLimitTier } : {}),
  };

  return buildClaudeCodeImportResult({
    identity: finalIdentity,
    tokenKind: 'oauth',
    accessToken,
    refreshToken,
    expiresAt: expiresAtRaw,
    now: new Date().toISOString(),
  });
};
