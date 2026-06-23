import { ensureCodexAccessToken, invalidateCodexAccessToken, mintCodexAccessToken, putCodexAccessToken } from './access-token-cache.ts';
import { CodexOAuthSessionTerminatedError } from './auth/oauth.ts';
import {
  CODEX_BACKEND_BASE,
  CODEX_RESPONSES_ORIGINATOR,
  CODEX_RESPONSES_PATH,
  CODEX_RESPONSES_USER_AGENT,
} from './constants.ts';
import {
  getCodexQuota,
  isCodexRateLimited,
  parseCodexQuotaHeaders,
  putCodexQuota,
} from './quota.ts';
import type { CodexAccountCredential } from './state.ts';
import type { ResponsesPayload, ResponsesStreamEvent } from '@floway-dev/protocols/responses';
import { parseResponsesStream } from '@floway-dev/protocols/responses';
import { streamingProviderCall, type ProviderStreamResult, type UpstreamCallOptions, type UpstreamModel } from '@floway-dev/provider';

// Hooks for repo-side state transitions, applied with optimistic concurrency.
// Refresh-token rotations and terminal-state transitions go through the repo;
// access-token and quota persistence are handled inside their own helpers
// (also state_json writes via the same CAS hook).
export interface CodexCallEffects {
  persistRefreshTokenRotation(newRefreshToken: string): Promise<void>;
  persistTerminalState(state: 'session_terminated' | 'refresh_failed', message: string): Promise<void>;
}

// The transport is account-agnostic — the caller selects the credential
// and passes it in.
export interface CallCodexResponsesOptions {
  upstreamId: string;
  account: CodexAccountCredential;
  model: UpstreamModel;
  body: Omit<ResponsesPayload, 'model'>;
  headers: Headers;
  signal?: AbortSignal;
  effects: CodexCallEffects;
  call: UpstreamCallOptions;
}

export const callCodexResponses = async (opts: CallCodexResponsesOptions): Promise<ProviderStreamResult<ResponsesStreamEvent>> => {
  // Pre-fetch gates short-circuit before reaching the network. The gateway
  // recorder still needs the contract observed (it throws on a provider that
  // returns without ever wrapping), so each synthetic response rides through
  // `recordUpstreamLatency` once. The captured ~0 ms is never read — the
  // gateway records `upstream_success` failures as a counter, not a latency.
  const syntheticReturn = async (response: Response): Promise<ProviderStreamResult<ResponsesStreamEvent>> => ({
    ok: false,
    modelKey: opts.model.id,
    response: await opts.call.recordUpstreamLatency(Promise.resolve(response)),
  });

  if (opts.account.state !== 'active') {
    return await syntheticReturn(synthetic503(`Codex upstream is ${opts.account.state}`));
  }

  const now = new Date();
  const quotaSnapshot = await getCodexQuota(opts.upstreamId, opts.account.chatgptAccountId);
  if (isCodexRateLimited(quotaSnapshot, now)) {
    return await syntheticReturn(
      synthetic429(`Codex upstream rate-limited until ${quotaSnapshot!.ratelimited_until!}`, quotaSnapshot!.ratelimited_until!, now),
    );
  }

  let accessToken: string;
  try {
    accessToken = await ensureAccessToken(opts);
  } catch (err) {
    if (err instanceof CodexOAuthSessionTerminatedError) {
      await opts.effects.persistTerminalState('refresh_failed', err.upstreamMessage);
      return await syntheticReturn(synthetic503(`Codex refresh failed: ${err.upstreamMessage}`));
    }
    throw err;
  }

  return await performUpstreamCall(opts, accessToken, false);
};

const mintAccessToken = (opts: CallCodexResponsesOptions, refreshToken: string) =>
  mintCodexAccessToken(refreshToken, opts.call.fetcher, opts.effects.persistRefreshTokenRotation);

const ensureAccessToken = async (opts: CallCodexResponsesOptions): Promise<string> => {
  const entry = await ensureCodexAccessToken(opts.upstreamId, opts.account.chatgptAccountId, refresh => mintAccessToken(opts, refresh));
  return entry.token;
};

const CODEX_RESPONSES_PASSTHROUGH_HEADERS = [
  'version',
  'x-codex-beta-features',
  'x-codex-turn-metadata',
  'x-client-request-id',
] as const;

const trimHeader = (headers: Headers, name: string): string | null => {
  const value = headers.get(name)?.trim();
  return value || null;
};

const setCodexSessionHeaders = (headers: Headers, source: Headers): void => {
  const sessionId = trimHeader(source, 'session-id') ?? trimHeader(source, 'session_id') ?? crypto.randomUUID();
  headers.set('session-id', sessionId);
};

const buildCodexResponsesHeaders = (opts: CallCodexResponsesOptions, accessToken: string): Headers => {
  const headers = new Headers();
  headers.set('authorization', `Bearer ${accessToken}`);
  headers.set('chatgpt-account-id', opts.account.chatgptAccountId);
  headers.set('originator', CODEX_RESPONSES_ORIGINATOR);
  headers.set('user-agent', CODEX_RESPONSES_USER_AGENT);
  headers.set('accept', 'text/event-stream');
  headers.set('content-type', 'application/json');
  setCodexSessionHeaders(headers, opts.headers);

  for (const name of CODEX_RESPONSES_PASSTHROUGH_HEADERS) {
    const value = opts.headers.get(name)?.trim();
    if (value) headers.set(name, value);
  }

  return headers;
};

const performUpstreamCall = async (
  opts: CallCodexResponsesOptions,
  accessToken: string,
  alreadyRetried: boolean,
): Promise<ProviderStreamResult<ResponsesStreamEvent>> => {
  const headers = buildCodexResponsesHeaders(opts, accessToken);

  const upstreamFetch = opts.call.fetcher(`${CODEX_BACKEND_BASE}${CODEX_RESPONSES_PATH}`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ ...opts.body, model: opts.model.id, store: false, stream: true }),
    signal: opts.signal,
  }, opts.call.recordUpstreamLatency).then(async response => {
    if (response.ok) {
      const responseNow = new Date();
      const snapshot = parseCodexQuotaHeaders(response.headers, { now: responseNow, isRateLimited: false });
      registerBackgroundWrite(opts, putCodexQuota(opts.upstreamId, opts.account.chatgptAccountId, snapshot));
      return ensureSseContentType(response);
    }

    if (response.status === 429) {
      const responseNow = new Date();
      const snapshot = parseCodexQuotaHeaders(response.headers, { now: responseNow, isRateLimited: true });
      registerBackgroundWrite(opts, putCodexQuota(opts.upstreamId, opts.account.chatgptAccountId, snapshot));
      return response;
    }

    if (response.status === 401) {
      const bodyText = await response.text();
      const { code, message } = parseUpstreamError(bodyText);
      if (code === 'token_invalidated') {
        await opts.effects.persistTerminalState('session_terminated', message);
        return synthetic503(`Codex session terminated: ${message}`);
      }
      return new Response(bodyText, { status: 401, headers: response.headers });
    }

    return response;
  });

  const result = await streamingProviderCall(upstreamFetch, parseResponsesStream, opts.model.id, opts.signal);

  if (!result.ok && result.response.status === 401 && !alreadyRetried) {
    await invalidateCodexAccessToken(opts.upstreamId, opts.account.chatgptAccountId);
    // Force a mint here rather than going through ensureCodexAccessToken's
    // read-then-maybe-mint. If the invalidate's CAS lost to a sibling write
    // (a concurrent quota putCodexQuota, refresh-token rotation, or operator
    // re-import all touch the same state_json row), the broken token still
    // sits in the slot and a re-read would hand it back as fresh — Codex
    // tokens carry multi-day expiresAt — sending us into an immediate second
    // 401 with alreadyRetried already flipped. Minting unconditionally and
    // persisting best-effort sidesteps that window; a CAS loss on persist is
    // fine because the next request will re-mint if its read still sees the
    // dead token.
    let newAccessToken: string;
    try {
      const minted = await mintAccessToken(opts, opts.account.refresh_token);
      registerBackgroundWrite(opts, putCodexAccessToken(opts.upstreamId, opts.account.chatgptAccountId, minted));
      newAccessToken = minted.token;
    } catch (err) {
      if (err instanceof CodexOAuthSessionTerminatedError) {
        await opts.effects.persistTerminalState('refresh_failed', err.upstreamMessage);
        return { ok: false, modelKey: opts.model.id, response: synthetic503(`Codex refresh failed: ${err.upstreamMessage}`) };
      }
      throw err;
    }
    return await performUpstreamCall(opts, newAccessToken, true);
  }

  return result;
};

const parseUpstreamError = (rawText: string): { code: string | null; message: string } => {
  try {
    const obj = JSON.parse(rawText) as { error?: { code?: unknown; message?: unknown }; detail?: unknown };
    const code = obj.error && typeof obj.error === 'object' && typeof obj.error.code === 'string' ? obj.error.code : null;
    const message = obj.error && typeof obj.error === 'object' && typeof obj.error.message === 'string'
      ? obj.error.message
      : typeof obj.detail === 'string' ? obj.detail : rawText.slice(0, 256);
    return { code, message };
  } catch {
    return { code: null, message: rawText.slice(0, 256) };
  }
};

const synthetic503 = (message: string): Response => new Response(JSON.stringify({ error: { type: 'codex_upstream_unavailable', message } }), {
  status: 503,
  headers: { 'content-type': 'application/json' },
});

const synthetic429 = (message: string, retryAtIso: string, now: Date): Response => {
  const retryAfterSeconds = Math.max(0, Math.ceil((new Date(retryAtIso).getTime() - now.getTime()) / 1000));
  return new Response(JSON.stringify({ error: { type: 'codex_rate_limited', message, retry_at: retryAtIso } }), {
    status: 429,
    headers: { 'content-type': 'application/json', 'retry-after': String(retryAfterSeconds) },
  });
};

// Codex backend serves SSE without setting `content-type: text/event-stream`
// (observed in production: only x-codex-* + standard CDN headers come back).
// The shared `streamingProviderCall` rejects 2xx responses lacking the SSE
// content-type as a contract violation, so we synthesize the header on the
// way through. Body stream is preserved verbatim.
const ensureSseContentType = (response: Response): Response => {
  if (response.headers.get('content-type')?.includes('text/event-stream')) return response;
  const headers = new Headers(response.headers);
  headers.set('content-type', 'text/event-stream');
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
};

// Hand best-effort writes to waitUntil so workerd does not cancel them when
// the streaming response returns; the swallow guards against recoverable
// noise (CAS losses on access-token / quota state_json rows, transient
// storage errors) tripping the request.
const registerBackgroundWrite = (opts: CallCodexResponsesOptions, write: Promise<void>): void => {
  opts.call.waitUntil(write.catch(() => {}));
};
