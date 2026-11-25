import {
  CLAUDE_CODE_AUTHORIZE_URL,
  CLAUDE_CODE_CLIENT_ID,
  CLAUDE_CODE_OAUTH_SCOPE,
  CLAUDE_CODE_OAUTH_SETUP_TOKEN_SCOPE,
  CLAUDE_CODE_OAUTH_TOKEN_URL,
  CLAUDE_CODE_OAUTH_USER_AGENT,
  CLAUDE_CODE_REDIRECT_URI,
  CLAUDE_CODE_SETUP_TOKEN_EXPIRES_IN_SECONDS,
} from '../constants.ts';
import { responseHeaderEntries, type FetchInit, type Fetcher, type HttpResponseFact, type HttpStreamError } from '@floway-dev/http';
import type { Result } from '@floway-dev/pipeline';
import { parseJSONWithRawNumbers } from '@floway-dev/protocols/common';

// Discriminates the two PKCE flows. `oauth` is the full Claude Code CLI
// sign-in: three-scope grant that mints a short-lived access token + rotating
// refresh token. `setup-token` is the inference-only long-lived bearer that
// Anthropic's "Create a Long-Lived Token" UI issues; no refresh_token, ~1
// year validity, cannot mint API keys. Both share authorize host, client_id,
// redirect_uri, and exchange endpoint — only the scope on the authorize URL
// and the optional `expires_in` on the exchange body differ.
export type ClaudeCodeOAuthFlowKind = 'oauth' | 'setup-token';

export interface ClaudeCodeOAuthTokenResponse {
  access_token: string;
  expires_in: number;
  // Absent on setup-token exchanges (the long-lived bearer has no rotation
  // counterpart). Always present on the full OAuth flow and on every
  // refresh-token round-trip.
  refresh_token?: string;
  scope: string;
}

// Terminal error: refresh_token is dead, operator must re-import. Distinct
// from generic OAuth 4xx so callers can react to session-termination
// separately from a transient upstream message. `code` carries the raw OAuth
// `error` value (`invalid_grant`, `app_session_terminated`, etc.) so the
// refresh-race recovery in the access-token module can single out
// `invalid_grant` — which is the only terminal code that might actually mean
// "a sibling worker just rotated the refresh token, and our copy is stale" —
// from codes that signal genuine credential death under any race scenario.
export class ClaudeCodeOAuthSessionTerminatedError extends Error {
  readonly code: string;
  readonly upstreamMessage: string;
  constructor(args: { code: string; message: string }) {
    super(`Claude Code OAuth session terminated: ${args.message}`);
    this.name = 'ClaudeCodeOAuthSessionTerminatedError';
    this.code = args.code;
    this.upstreamMessage = args.message;
  }
}

// Terminal-code sets are split by grant type, mirroring codex
// (provider-chatgpt/src/auth/oauth.ts:100-104, :117-123). The refresh-side
// codes match sub2api's `isNonRetryableRefreshError`
// (backend/internal/service/token_refresh_service.go:429-451) — all signal
// a dead credential that only re-import can recover. `invalid_grant`
// on the PKCE exchange means the operator pasted a stale or wrong
// callback URL — recoverable by restarting the PKCE flow, not by
// re-importing — so it is not terminal on the exchange path.
const EXCHANGE_TERMINAL_OAUTH_CODES: ReadonlySet<string> = new Set([
  'app_session_terminated',
]);
const REFRESH_TERMINAL_OAUTH_CODES: ReadonlySet<string> = new Set([
  'app_session_terminated',
  'invalid_grant',
  'invalid_refresh_token',
  'invalid_client',
  'unauthorized_client',
  'access_denied',
]);

// Coalesced refreshes outlive any single Anthropic Messages caller.
export type ClaudeCodeOAuthFetcher = (url: string, init: Omit<FetchInit, 'signal'>) => Promise<Result<Response, HttpStreamError>>;

type OAuthErrorBody = { readonly kind: 'json'; readonly value: unknown } | { readonly kind: 'text'; readonly text: string };

export interface ClaudeCodeOAuthFailure {
  readonly http: HttpResponseFact | null;
  readonly cause: Error | HttpStreamError;
  readonly body: OAuthErrorBody | null;
}

const failed = (
  http: HttpResponseFact | null,
  cause: ClaudeCodeOAuthFailure['cause'],
  body: OAuthErrorBody | null = null,
): Result<never, ClaudeCodeOAuthFailure> => ({ ok: false, error: { http, cause, body } });

export const controlOAuthFetcher = (fetcher: Fetcher): ClaudeCodeOAuthFetcher => async (url, init) => {
  try {
    return { ok: true, value: await fetcher(url, init) };
  } catch (cause) {
    return { ok: false, error: { kind: 'transport', cause } };
  }
};

export const unwrapOAuthResult = <T>(result: Result<T, ClaudeCodeOAuthFailure>): T => {
  if (result.ok) return result.value;
  const { cause } = result.error;
  throw cause instanceof Error ? cause : cause.cause;
};

const claudeCodeTokenRequest = async (
  body: Record<string, string | number>,
  terminalCodes: ReadonlySet<string>,
  fetcher: ClaudeCodeOAuthFetcher,
): Promise<Result<{ token: ClaudeCodeOAuthTokenResponse; http: HttpResponseFact }, ClaudeCodeOAuthFailure>> => {
  const fetched = await fetcher(CLAUDE_CODE_OAUTH_TOKEN_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'user-agent': CLAUDE_CODE_OAUTH_USER_AGENT,
      accept: 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!fetched.ok) return failed(null, fetched.error);
  const response = fetched.value;
  const { status, statusText } = response;
  const http: HttpResponseFact = { status, statusText, headers: responseHeaderEntries(response), body: null };

  let rawText: string;
  try {
    rawText = await response.text();
  } catch (cause) {
    return failed(http, { kind: 'transport', cause });
  }
  let parsed: unknown;
  try {
    parsed = rawText.length === 0 ? {} : response.ok ? JSON.parse(rawText) : parseJSONWithRawNumbers(rawText);
  } catch (cause) {
    if (!(cause instanceof SyntaxError)) throw cause;
    const error = new Error(`Claude Code OAuth /token returned ${status} with a non-JSON body`, { cause });
    return failed(http, error, response.ok ? null : { kind: 'text', text: rawText });
  }

  const root = (typeof parsed === 'object' && parsed !== null) ? (parsed as Record<string, unknown>) : null;

  if (!response.ok) {
    let code: string | null = null;
    let nestedMessage: string | null = null;
    if (typeof root?.error === 'string') {
      code = root.error;
    } else if (typeof root?.error === 'object' && root.error !== null && !Array.isArray(root.error)) {
      const err = root.error as Record<string, unknown>;
      if (typeof err.code === 'string') code = err.code;
      if (typeof err.message === 'string') nestedMessage = err.message;
    }
    // Anthropic's OAuth surfaces a human-readable message in
    // `error_description`; prefer that over the nested error object's
    // message and over the bare `error` code so the operator sees
    // "Refresh token revoked" rather than "invalid_grant".
    const message =
      (typeof root?.error_description === 'string' ? root.error_description : null)
      ?? (typeof root?.detail === 'string' ? root.detail : null)
      ?? nestedMessage
      ?? code
      ?? rawText.slice(0, 256);
    const error = code && terminalCodes.has(code)
      ? new ClaudeCodeOAuthSessionTerminatedError({ code, message })
      : new Error(`Claude Code OAuth /token returned ${status}: ${message}`);
    return failed(http, error, rawText.length === 0 ? { kind: 'text', text: rawText } : { kind: 'json', value: parsed });
  }

  if (root === null) return failed(http, new Error('Claude Code OAuth /token response is not an object'));
  if (typeof root.access_token !== 'string' || root.access_token === '') {
    return failed(http, new Error('Claude Code OAuth /token response missing access_token'));
  }
  if (typeof root.expires_in !== 'number' || !Number.isFinite(root.expires_in)) {
    return failed(http, new Error('Claude Code OAuth /token response missing expires_in'));
  }
  if (root.refresh_token !== undefined && (typeof root.refresh_token !== 'string' || root.refresh_token === '')) {
    return failed(http, new Error('Claude Code OAuth /token response carries non-string refresh_token'));
  }
  if (typeof root.scope !== 'string') {
    return failed(http, new Error('Claude Code OAuth /token response missing scope'));
  }
  return {
    ok: true,
    value: {
      http,
      token: {
        access_token: root.access_token,
        expires_in: root.expires_in,
        ...(typeof root.refresh_token === 'string' ? { refresh_token: root.refresh_token } : {}),
        scope: root.scope,
      },
    },
  };
};

// `kind: 'setup-token'` switches the exchange to request the 1-year
// inference-only bearer by adding `expires_in: 31536000` to the body —
// matches sub2api `claude_oauth_service.go:200-203` and crs
// `oauthHelper.js:386`. The response has no `refresh_token`; callers reading
// `result.refresh_token` after a setup-token exchange must tolerate
// `undefined`.
//
// `fetcher` is caller-supplied so the control-plane import route can route
// the exchange through an operator-supplied proxy fallback chain — the same
// chain that will be persisted on the new upstream. Pass `directFetcher`
// for direct egress.
export const exchangeClaudeCodeAuthorizationCode = async (opts: {
  code: string;
  codeVerifier: string;
  state: string;
  kind: ClaudeCodeOAuthFlowKind;
  fetcher: Fetcher;
}): Promise<ClaudeCodeOAuthTokenResponse> => {
  const body: Record<string, string | number> = {
    grant_type: 'authorization_code',
    code: opts.code,
    client_id: CLAUDE_CODE_CLIENT_ID,
    redirect_uri: CLAUDE_CODE_REDIRECT_URI,
    code_verifier: opts.codeVerifier,
    // Anthropic's /v1/oauth/token rejects exchanges that omit `state` with
    // 400 "Invalid request format", even though the standard OAuth2 RFC
    // treats state as a client-side CSRF guard only. Mirrors sub2api +
    // claude-relay-service, which both include it on every exchange.
    state: opts.state,
  };
  if (opts.kind === 'setup-token') {
    body.expires_in = CLAUDE_CODE_SETUP_TOKEN_EXPIRES_IN_SECONDS;
  }
  return unwrapOAuthResult(await claudeCodeTokenRequest(body, EXCHANGE_TERMINAL_OAUTH_CODES, controlOAuthFetcher(opts.fetcher))).token;
};

// `fetcher` is required because the refresh has an associated upstream
// and must flow through that upstream's proxy-aware fallback chain rather
// than direct egress.
export const refreshClaudeCodeAccessToken = async (
  refreshToken: string,
  fetcher: ClaudeCodeOAuthFetcher,
): Promise<Result<ClaudeCodeOAuthTokenResponse & { refresh_token: string }, ClaudeCodeOAuthFailure>> => {
  const body = {
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: CLAUDE_CODE_CLIENT_ID,
  };
  const result = await claudeCodeTokenRequest(body, REFRESH_TERMINAL_OAUTH_CODES, fetcher);
  if (!result.ok) return result;
  const { http, token } = result.value;
  if (token.refresh_token === undefined) return failed(http, new Error('Claude Code refresh response missing refresh_token'));
  return { ok: true, value: { ...token, refresh_token: token.refresh_token } };
};

// The literal `code=true` query param matches what the real Claude Code CLI
// emits during sign-in. `kind: 'setup-token'` swaps the 6-scope grant for
// the inference-only scope while leaving every other parameter identical —
// matches sub2api `oauth.go:170-183` and crs
// `oauthHelper.js:generateSetupTokenAuthUrl`. The two host/path/client_id
// fields are pinned by Anthropic for this OAuth client and never differ
// between flows.
export const buildClaudeCodeAuthorizeUrl = (args: {
  state: string;
  codeChallenge: string;
  kind: ClaudeCodeOAuthFlowKind;
}): string => {
  const scope = args.kind === 'setup-token'
    ? CLAUDE_CODE_OAUTH_SETUP_TOKEN_SCOPE
    : CLAUDE_CODE_OAUTH_SCOPE;
  const params = new URLSearchParams({
    client_id: CLAUDE_CODE_CLIENT_ID,
    response_type: 'code',
    code: 'true',
    redirect_uri: CLAUDE_CODE_REDIRECT_URI,
    scope,
    state: args.state,
    code_challenge: args.codeChallenge,
    code_challenge_method: 'S256',
  });
  return `${CLAUDE_CODE_AUTHORIZE_URL}?${params.toString()}`;
};
