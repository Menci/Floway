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

export interface CodexOAuthTokens {
  access_token: string;
  refresh_token: string;
  id_token: string;
  // Lifetime in seconds, relative to the server's clock at issue time.
  expires_in: number;
}

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
): Promise<CodexOAuthTokens> => {
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
  for (const key of ['access_token', 'refresh_token', 'id_token'] as const) {
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
    id_token: root.id_token as string,
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
  return await codexTokenRequest(body, EXCHANGE_TERMINAL_OAUTH_CODES, opts.fetcher);
};

// `fetcher` is required because the refresh has an associated upstream
// and must flow through that upstream's proxy-aware fallback chain rather
// than direct egress.
export const refreshCodexAccessToken = async (refreshToken: string, fetcher: Fetcher): Promise<CodexOAuthTokens> => {
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
  return await codexTokenRequest(body, REFRESH_TERMINAL_OAUTH_CODES, fetcher);
};
