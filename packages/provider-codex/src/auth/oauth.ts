import {
  CODEX_AUTHORIZE_URL,
  CODEX_CLIENT_ID,
  CODEX_OAUTH_SCOPE,
  CODEX_OAUTH_TOKEN_URL,
  CODEX_OAUTH_USER_AGENT,
  CODEX_ORIGINATOR,
  CODEX_REDIRECT_URI,
} from '../constants.ts';
import type { Fetcher } from '@floway-dev/provider';

// What /token actually guarantees. A refresh response has been observed to
// omit `id_token`, so the field is optional here and each caller states
// whether its own path needs one.
export interface CodexOAuthRefreshTokens {
  access_token: string;
  refresh_token: string;
  // Lifetime in seconds, relative to the server's clock at issue time.
  expires_in: number;
  // Present only when the upstream supplies it. Refresh re-mints the bearer
  // only — identity was settled at import — but the id_token does carry the
  // account's latest plan, which refresh-side plan observation reads.
  id_token?: string;
}

export interface CodexOAuthTokens extends CodexOAuthRefreshTokens {
  id_token: string;
}

// OAuth `expires_in` is a lifetime in seconds measured from issue; callers
// store an absolute unix-ms expiry, so convert it anchored at the current
// wall clock. The gap between that anchor and the server's issue time sits
// inside the refresh window the access-token module already tolerates.
export const codexTokenExpiresAt = (expiresInSeconds: number): number => Date.now() + expiresInSeconds * 1000;

export const buildCodexAuthorizeUrl = (input: { state: string; codeChallenge: string }): string => {
  const url = new URL(CODEX_AUTHORIZE_URL);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', CODEX_CLIENT_ID);
  url.searchParams.set('redirect_uri', CODEX_REDIRECT_URI);
  url.searchParams.set('scope', CODEX_OAUTH_SCOPE);
  url.searchParams.set('state', input.state);
  url.searchParams.set('code_challenge', input.codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('id_token_add_organizations', 'true');
  url.searchParams.set('codex_cli_simplified_flow', 'true');
  url.searchParams.set('originator', CODEX_ORIGINATOR);
  return url.toString();
};

// Terminal error: refresh_token is dead, operator must re-import. Distinct
// from generic OAuth 4xx so callers can react to session-termination
// separately from a transient upstream message. `code` carries the raw OAuth
// `error` value (`invalid_grant`, `app_session_terminated`, etc.) so the
// refresh-race recovery in the access-token module can single out
// `invalid_grant` — the only terminal code that might mean "a sibling
// worker just rotated the refresh token, and our copy is stale" — from
// codes that signal genuine credential death under any race scenario.
export class CodexOAuthSessionTerminatedError extends Error {
  readonly code: string;
  readonly upstreamMessage: string;
  constructor(args: { code: string; message: string }) {
    super(`Codex OAuth session terminated: ${args.message}`);
    this.name = 'CodexOAuthSessionTerminatedError';
    this.code = args.code;
    this.upstreamMessage = args.message;
  }
}

// Terminal codes accepted on the authorization-code exchange. This is OUR
// classification (codex-rs/login/src/server.rs does not split errors into
// terminal vs recoverable on this path), but `app_session_terminated`
// observably means the upstream account is gone — there is nothing the
// operator can do besides re-import after fixing the underlying account.
// `invalid_grant` on exchange typically means the operator pasted a stale
// or wrong callback URL, which is recoverable by restarting the PKCE flow
// rather than re-importing, so it stays out of this set.
const EXCHANGE_TERMINAL_OAUTH_CODES: ReadonlySet<string> = new Set([
  'app_session_terminated',
]);

// Terminal codes on the refresh path: every one of these signals a dead
// refresh_token that only operator re-import recovers. Aligned with
// sub2api's `isNonRetryableRefreshError`
// (backend/internal/service/token_refresh_service.go:429-451), which shares
// the same list across OpenAI/Claude/Gemini OAuth — Codex is OpenAI OAuth,
// so the set carries over verbatim. `invalid_grant` is included even though
// the refresh-race recovery in access-token.ts may re-classify it
// when a sibling rotation is detected; from the OAuth wire's perspective
// it is still a terminal signal.
const REFRESH_TERMINAL_OAUTH_CODES: ReadonlySet<string> = new Set([
  'app_session_terminated',
  'invalid_grant',
  'invalid_refresh_token',
  'invalid_client',
  'unauthorized_client',
  'access_denied',
]);

const codexTokenRequest = async (
  body: URLSearchParams,
  terminalCodes: ReadonlySet<string>,
  fetcher: Fetcher,
): Promise<CodexOAuthRefreshTokens> => {
  const response = await fetcher(CODEX_OAUTH_TOKEN_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      'user-agent': CODEX_OAUTH_USER_AGENT,
      accept: 'application/json',
    },
    body: body.toString(),
  });

  const rawText = await response.text();
  let parsed: unknown;
  try {
    parsed = rawText.length > 0 ? JSON.parse(rawText) : {};
  } catch {
    parsed = { _nonJsonBody: rawText };
  }

  const root = (typeof parsed === 'object' && parsed !== null) ? (parsed as Record<string, unknown>) : null;

  if (!response.ok) {
    let code: string | null = null;
    let message: string | null = null;
    if (typeof root?.error === 'string') {
      code = root.error;
      message = code;
    } else if (root && typeof root.error === 'object' && root.error !== null) {
      const err = root.error as Record<string, unknown>;
      if (typeof err.code === 'string') code = err.code;
      if (typeof err.message === 'string') message = err.message;
    }
    // Some OpenAI errors put the human-readable text under top-level `.detail`.
    if (message === null && typeof root?.detail === 'string') message = root.detail as string;
    message ??= rawText.slice(0, 256);
    if (code && terminalCodes.has(code)) {
      throw new CodexOAuthSessionTerminatedError({ code, message });
    }
    throw new Error(`Codex OAuth /token returned ${response.status}: ${message}`);
  }

  if (root === null) throw new Error('Codex OAuth /token response is not an object');
  for (const key of ['access_token', 'refresh_token'] as const) {
    if (typeof root[key] !== 'string' || root[key] === '') {
      throw new Error(`Codex OAuth /token response missing ${key}`);
    }
  }
  if (typeof root.expires_in !== 'number' || !Number.isFinite(root.expires_in)) {
    throw new Error('Codex OAuth /token response missing expires_in');
  }
  return {
    access_token: root.access_token as string,
    refresh_token: root.refresh_token as string,
    ...(typeof root.id_token === 'string' && root.id_token !== '' ? { id_token: root.id_token } : {}),
    expires_in: root.expires_in as number,
  };
};

// PKCE exchange runs before the upstream record exists, so there is no
// persisted proxy chain to read here — the caller must supply the fetcher
// explicitly. Making `fetcher` required (rather than defaulting to direct
// egress) keeps every call site honest: callers that want direct egress
// pass `directFetcher` themselves, and the import path can't accidentally
// bypass an operator-configured proxy.
export const exchangeCodexAuthorizationCode = async (opts: { code: string; codeVerifier: string; fetcher: Fetcher }): Promise<CodexOAuthTokens> => {
  // auth.openai.com rejects exchanges that include a `state` parameter with
  // 400 unknown_parameter (live-probed). The upstream Codex CLI's
  // `exchange_code_for_tokens` in codex-rs/login/src/server.rs deliberately
  // omits it — we mirror that. (Anthropic's analogous endpoint, by
  // contrast, requires `state` on exchange — handled separately in
  // provider-claude-code.)
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: CODEX_CLIENT_ID,
    code: opts.code,
    redirect_uri: CODEX_REDIRECT_URI,
    code_verifier: opts.codeVerifier,
  });
  const tokens = await codexTokenRequest(body, EXCHANGE_TERMINAL_OAUTH_CODES, opts.fetcher);
  // The authorization-code grant is the one path that must return an
  // id_token: it is a fresh consent, and the identity claims it carries are
  // the only ones this flow ever gets to see.
  if (tokens.id_token === undefined) {
    throw new Error('Codex OAuth /token response missing id_token');
  }
  return { ...tokens, id_token: tokens.id_token };
};

// `fetcher` is required because the refresh has an associated upstream
// and must flow through that upstream's proxy-aware fallback chain rather
// than direct egress.
export const refreshCodexAccessToken = async (refreshToken: string, fetcher: Fetcher): Promise<CodexOAuthRefreshTokens> => {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: CODEX_CLIENT_ID,
    scope: CODEX_OAUTH_SCOPE,
  });
  // OAuth `invalid_grant` on the refresh path is ambiguous on its own — it
  // can mean a genuinely revoked/expired refresh_token, *or* that a sibling
  // worker raced us, won the rotation, and our copy is now stale. The
  // access-token module's `recoverFromRefreshRace` distinguishes by re-reading
  // upstream state; the other codes here always mean credential death.
  const tokens = await codexTokenRequest(body, REFRESH_TERMINAL_OAUTH_CODES, fetcher);
  // A refresh only re-mints the bearer. Whatever identity the account has was
  // settled at import, so the id_token here (when present) is used for the
  // account's latest plan observation, never to re-litigate identity.
  return {
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    expires_in: tokens.expires_in,
    ...(tokens.id_token === undefined ? {} : { id_token: tokens.id_token }),
  };
};
