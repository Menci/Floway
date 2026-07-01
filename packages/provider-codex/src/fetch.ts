import { ensureCodexAccessToken, invalidateCodexAccessToken, mintCodexAccessToken, putCodexAccessToken } from './access-token-cache.ts';
import { CodexOAuthSessionTerminatedError } from './auth/oauth.ts';
import {
  CODEX_BACKEND_BASE,
  CODEX_ORIGINATOR,
  CODEX_RESPONSES_COMPACT_PATH,
  CODEX_RESPONSES_PATH,
  CODEX_USER_AGENT,
} from './constants.ts';
import {
  getCodexQuota,
  isCodexRateLimited,
  parseCodexQuotaHeaders,
  putCodexQuota,
} from './quota.ts';
import type { CodexAccountCredential } from './state.ts';
import type { ResponsesCompactPayload, ResponsesPayload, ResponsesResult, ResponsesStreamEvent } from '@floway-dev/protocols/responses';
import { parseResponsesStream } from '@floway-dev/protocols/responses';
import { type ProviderModel, type ProviderStreamResult, streamingProviderCall, type UpstreamCallOptions } from '@floway-dev/provider';

// Pre-tagging shape used by the unary compact backend call; the codex provider
// terminal re-tags it onto the unified `ProviderResponsesResult` with
// `action: 'compact'`. Other providers build the tagged compact variant
// directly at their call sites, so the shape is provider-local.
export type ProviderCompactionResult =
  | { ok: true; result: ResponsesResult; modelKey: string }
  | { ok: false; response: Response; modelKey: string };

// Hooks for repo-side state transitions, applied with optimistic concurrency.
// Refresh-token rotations and terminal-state transitions go through the repo;
// access-token and quota persistence are handled inside their own helpers
// (also state_json writes via the same CAS hook).
export interface CodexCallEffects {
  persistRefreshTokenRotation(newRefreshToken: string): Promise<void>;
  persistTerminalState(state: 'session_terminated' | 'refresh_failed', message: string): Promise<void>;
}

// Account selection + per-call observation hooks. Both Codex endpoints share
// the same OAuth credential, the same quota row, and the same retry/recorder
// contract; only the wire body and the response decoding differ.
interface CodexBackendCallBase {
  upstreamId: string;
  account: CodexAccountCredential;
  model: ProviderModel;
  headers: Headers;
  signal?: AbortSignal;
  effects: CodexCallEffects;
  call: UpstreamCallOptions;
}

export interface CallCodexResponsesOptions extends CodexBackendCallBase {
  body: Omit<ResponsesPayload, 'model'>;
}

export interface CallCodexResponsesCompactOptions extends CodexBackendCallBase {
  body: Omit<ResponsesCompactPayload, 'model' | 'store'>;
}

export const callCodexResponses = async (opts: CallCodexResponsesOptions): Promise<ProviderStreamResult<ResponsesStreamEvent>> => {
  const ready = await prepareCodexCall(opts);
  if (!ready.ok) return { ok: false, modelKey: opts.model.id, response: ready.response };
  return await performStreamingResponsesCall(opts, ready.accessToken, false);
};

export const callCodexResponsesCompact = async (opts: CallCodexResponsesCompactOptions): Promise<ProviderCompactionResult> => {
  const ready = await prepareCodexCall(opts);
  if (!ready.ok) return { ok: false, modelKey: opts.model.id, response: ready.response };
  return await performUnaryCompactCall(opts, ready.accessToken, false);
};

// Pre-fetch gates + initial access-token mint. Each synthetic failure rides
// through the per-call latency recorder once so the gateway's wrap-once
// contract holds even when no upstream HTTP ever leaves the process — the
// captured ~0 ms is never read (gateway records `upstream_success` failures
// as a counter), but a missing wrap is a contract violation.
const prepareCodexCall = async (opts: CodexBackendCallBase): Promise<{ ok: true; accessToken: string } | { ok: false; response: Response }> => {
  const wrapSynthetic = (response: Response) => opts.call.recordUpstreamLatency(Promise.resolve(response));

  if (opts.account.state !== 'active') {
    return { ok: false, response: await wrapSynthetic(synthetic503(`Codex upstream is ${opts.account.state}`)) };
  }

  const now = new Date();
  const quotaSnapshot = await getCodexQuota(opts.upstreamId, opts.account.chatgptAccountId);
  if (isCodexRateLimited(quotaSnapshot, now)) {
    return {
      ok: false,
      response: await wrapSynthetic(
        synthetic429(`Codex upstream rate-limited until ${quotaSnapshot!.ratelimited_until!}`, quotaSnapshot!.ratelimited_until!, now),
      ),
    };
  }

  try {
    const entry = await ensureCodexAccessToken(opts.upstreamId, opts.account.chatgptAccountId, refresh => mintAccessToken(opts, refresh));
    return { ok: true, accessToken: entry.token };
  } catch (err) {
    if (err instanceof CodexOAuthSessionTerminatedError) {
      await opts.effects.persistTerminalState('refresh_failed', err.upstreamMessage);
      return { ok: false, response: await wrapSynthetic(synthetic503(`Codex refresh failed: ${err.upstreamMessage}`)) };
    }
    throw err;
  }
};

const mintAccessToken = (opts: CodexBackendCallBase, refreshToken: string) =>
  mintCodexAccessToken(refreshToken, opts.call.fetcher, opts.effects.persistRefreshTokenRotation);

// One upstream round-trip with quota-header persistence and terminal-401
// classification. The returned Response is what the caller relays:
//   - 2xx: caller decodes the body (SSE for /responses, JSON for /responses/compact)
//   - 429: quota is already snapshotted; return verbatim
//   - 401: a `token_invalidated` error is mapped to a synthetic 503; any
//     other 401 is rebuilt with a re-readable body so the caller can decide
//     to retry with a fresh access token
//   - other: returned verbatim
const dispatchCodexHttpCall = async (
  opts: CodexBackendCallBase,
  accessToken: string,
  path: string,
  accept: string,
  body: Record<string, unknown>,
): Promise<Response> => {
  // `opts.headers` is the provider's private boundary-ctx clone; mutate
  // directly. Every header below uses `set`, so retry passes overwrite
  // rather than accumulate.
  const headers = opts.headers;
  headers.set('authorization', `Bearer ${accessToken}`);
  headers.set('chatgpt-account-id', opts.account.chatgptAccountId);
  headers.set('originator', CODEX_ORIGINATOR);
  headers.set('user-agent', CODEX_USER_AGENT);
  headers.set('accept', accept);
  headers.set('content-type', 'application/json');

  const response = await opts.call.fetcher(`${CODEX_BACKEND_BASE}${path}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: opts.signal,
  }, opts.call.recordUpstreamLatency);

  if (response.ok) {
    const responseNow = new Date();
    const snapshot = parseCodexQuotaHeaders(response.headers, { now: responseNow, isRateLimited: false });
    registerBackgroundWrite(opts, putCodexQuota(opts.upstreamId, opts.account.chatgptAccountId, snapshot));
    return response;
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
};

// Force-mint a fresh access token after a 401, persisting it best-effort.
// `ensureCodexAccessToken`'s read-then-maybe-mint is bypassed: if the
// invalidate's CAS lost to a sibling write (a concurrent quota putCodexQuota,
// refresh-token rotation, or operator re-import all touch the same state_json
// row), the broken token still sits in the slot and a re-read would hand it
// back as fresh — Codex tokens carry multi-day expiresAt — sending us into
// an immediate second 401 with `alreadyRetried` already flipped. Minting
// unconditionally and persisting best-effort sidesteps that window; a CAS
// loss on persist is fine because the next request will re-mint if its read
// still sees the dead token.
const refreshAccessTokenForRetry = async (opts: CodexBackendCallBase): Promise<{ ok: true; accessToken: string } | { ok: false; response: Response }> => {
  await invalidateCodexAccessToken(opts.upstreamId, opts.account.chatgptAccountId);
  try {
    const minted = await mintAccessToken(opts, opts.account.refresh_token);
    registerBackgroundWrite(opts, putCodexAccessToken(opts.upstreamId, opts.account.chatgptAccountId, minted));
    return { ok: true, accessToken: minted.token };
  } catch (err) {
    if (err instanceof CodexOAuthSessionTerminatedError) {
      await opts.effects.persistTerminalState('refresh_failed', err.upstreamMessage);
      return { ok: false, response: synthetic503(`Codex refresh failed: ${err.upstreamMessage}`) };
    }
    throw err;
  }
};

const performStreamingResponsesCall = async (
  opts: CallCodexResponsesOptions,
  accessToken: string,
  alreadyRetried: boolean,
): Promise<ProviderStreamResult<ResponsesStreamEvent>> => {
  const upstreamFetch = dispatchCodexHttpCall(
    opts,
    accessToken,
    CODEX_RESPONSES_PATH,
    'text/event-stream',
    { ...opts.body, model: opts.model.id, store: false, stream: true },
  ).then(ensureSseContentType);

  const result = await streamingProviderCall(upstreamFetch, parseResponsesStream, opts.model.id, opts.signal);

  if (!result.ok && result.response.status === 401 && !alreadyRetried) {
    const fresh = await refreshAccessTokenForRetry(opts);
    if (!fresh.ok) return { ok: false, modelKey: opts.model.id, response: fresh.response };
    return await performStreamingResponsesCall(opts, fresh.accessToken, true);
  }

  return result;
};

const performUnaryCompactCall = async (
  opts: CallCodexResponsesCompactOptions,
  accessToken: string,
  alreadyRetried: boolean,
): Promise<ProviderCompactionResult> => {
  const response = await dispatchCodexHttpCall(
    opts,
    accessToken,
    CODEX_RESPONSES_COMPACT_PATH,
    'application/json',
    { ...opts.body, model: opts.model.id },
  );

  if (response.status === 401 && !alreadyRetried) {
    const fresh = await refreshAccessTokenForRetry(opts);
    if (!fresh.ok) return { ok: false, modelKey: opts.model.id, response: fresh.response };
    return await performUnaryCompactCall(opts, fresh.accessToken, true);
  }

  if (!response.ok) return { ok: false, modelKey: opts.model.id, response };

  const result = await response.json() as ResponsesResult;
  return { ok: true, modelKey: opts.model.id, result };
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
const registerBackgroundWrite = (opts: CodexBackendCallBase, write: Promise<void>): void => {
  opts.call.waitUntil(write.catch(() => {}));
};
