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
import { type Fetcher } from '@floway-dev/provider';

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
// (provider-codex/src/auth/oauth.ts:100-104, :117-123). The refresh-side
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

const claudeCodeTokenRequest = async (
  body: Record<string, string | number>,
  terminalCodes: ReadonlySet<string>,
  fetcher: Fetcher,
): Promise<ClaudeCodeOAuthTokenResponse> => {
  const response = await fetcher(CLAUDE_CODE_OAUTH_TOKEN_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'user-agent': CLAUDE_CODE_OAUTH_USER_AGENT,
      accept: 'application/json',
    },
    body: JSON.stringify(body),
  });

  const rawText = await response.text();
  let parsed: unknown;
  try {
    parsed = rawText.length > 0 ? JSON.parse(rawText) : {};
  } catch (cause) {
    throw new Error(
      `Claude Code OAuth /token returned ${response.status} with non-JSON body: ${rawText.slice(0, 256)}`,
      { cause },
    );
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
    if (code && terminalCodes.has(code)) {
      throw new ClaudeCodeOAuthSessionTerminatedError({ code, message });
    }
    throw new Error(`Claude Code OAuth /token returned ${response.status}: ${message}`);
  }

  if (root === null) throw new Error('Claude Code OAuth /token response is not an object');
  if (typeof root.access_token !== 'string' || root.access_token === '') {
    throw new Error('Claude Code OAuth /token response missing access_token');
  }
  if (typeof root.expires_in !== 'number' || !Number.isFinite(root.expires_in)) {
    throw new Error('Claude Code OAuth /token response missing expires_in');
  }
  if (root.refresh_token !== undefined && (typeof root.refresh_token !== 'string' || root.refresh_token === '')) {
    throw new Error('Claude Code OAuth /token response carries non-string refresh_token');
  }
  if (typeof root.scope !== 'string') {
    throw new Error('Claude Code OAuth /token response missing scope');
  }
  return {
    access_token: root.access_token,
    expires_in: root.expires_in,
    refresh_token: typeof root.refresh_token === 'string' ? root.refresh_token : undefined,
    scope: root.scope,
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
  return await claudeCodeTokenRequest(body, EXCHANGE_TERMINAL_OAUTH_CODES, opts.fetcher);
};

// `fetcher` is required because the refresh has an associated upstream
// and must flow through that upstream's proxy-aware fallback chain rather
// than direct egress.
export const refreshClaudeCodeAccessToken = async (
  refreshToken: string,
  fetcher: Fetcher,
): Promise<ClaudeCodeOAuthTokenResponse> => {
  const body = {
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: CLAUDE_CODE_CLIENT_ID,
  };
  return await claudeCodeTokenRequest(body, REFRESH_TERMINAL_OAUTH_CODES, fetcher);
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
