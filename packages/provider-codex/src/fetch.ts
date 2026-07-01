import { ensureCodexAccessToken, invalidateCodexAccessToken, mintCodexAccessToken, putCodexAccessToken } from './access-token-cache.ts';
import { CodexOAuthSessionTerminatedError } from './auth/oauth.ts';
import {
  CODEX_BACKEND_BASE,
  CODEX_ORIGINATOR,
  CODEX_RESPONSES_COMPACT_PATH,
  CODEX_RESPONSES_PATH,
  CODEX_USER_AGENT,
} from './constants.ts';
import { sha256Uuid } from './ids.ts';
import {
  getCodexQuota,
  isCodexRateLimited,
  parseCodexQuotaHeaders,
  putCodexQuota,
} from './quota.ts';
import type { CodexAccountCredential } from './state.ts';
import type { ResponsesCompactPayload, ResponsesPayload, ResponsesResult, ResponsesStreamEvent } from '@floway-dev/protocols/responses';
import { parseResponsesStream } from '@floway-dev/protocols/responses';
import { type ProviderModel, type ProviderStreamResult, streamingProviderCall, uuidV7, type UpstreamCallOptions } from '@floway-dev/provider';

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
  turnMetadata?: CodexTurnMetadataOptions;
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

interface CodexRequestIdentity {
  installationId: string;
  sessionId: string;
  threadId: string;
  clientRequestId: string;
  turnId: string;
  windowId: string;
}

export interface CodexCompactionTurnMetadata {
  trigger: 'manual' | 'auto';
  reason: 'user_requested' | 'context_limit';
  implementation: 'responses_compact' | 'responses_compaction_v2';
  phase: 'standalone_turn' | 'mid_turn';
  strategy: 'memento';
}

export interface CodexTurnMetadataOptions {
  requestKind: 'turn' | 'compaction';
  compaction?: CodexCompactionTurnMetadata;
}

export const CODEX_RESPONSES_COMPACTION_V2_TURN_METADATA: CodexTurnMetadataOptions = {
  requestKind: 'compaction',
  compaction: {
    trigger: 'manual',
    reason: 'user_requested',
    implementation: 'responses_compaction_v2',
    phase: 'standalone_turn',
    strategy: 'memento',
  },
};

const trimHeader = (headers: Headers, name: string): string | null => {
  const value = headers.get(name)?.trim() ?? '';
  return value.length > 0 ? value : null;
};

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const stringField = (record: Record<string, unknown> | null, key: string): string | null => {
  if (record === null) return null;
  const value = record[key];
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

const clientCodexClientMetadata = (body: unknown): Record<string, unknown> => {
  if (!isPlainObject(body)) return {};
  const candidate = body.client_metadata;
  return isPlainObject(candidate) ? candidate : {};
};

const parseClientTurnMetadataJson = (raw: string | null): Record<string, unknown> | null => {
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return isPlainObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
};

// Identity-mirror keys live on `identity` and are projected onto every
// surface (headers, body's `client_metadata`, body's `x-codex-turn-metadata`
// blob). Drop them from caller spreads so a caller that supplies the same
// key on a different surface than identity already absorbed can't force the
// three projections to disagree.
const IDENTITY_MIRRORED_TURN_METADATA_KEYS = new Set<string>([
  'installation_id', 'session_id', 'thread_id', 'turn_id', 'window_id',
]);

const IDENTITY_MIRRORED_CLIENT_METADATA_KEYS = new Set<string>([
  'x-codex-installation-id', 'session_id', 'thread_id', 'x-codex-window-id', 'turn_id', 'x-codex-turn-metadata',
]);

const buildCodexRequestIdentity = async (
  opts: CodexBackendCallBase,
  body: unknown,
  clientMetadata: Record<string, unknown>,
  clientTurnMetadata: Record<string, unknown> | null,
): Promise<CodexRequestIdentity> => {
  // Identity priority for every mirrored id: caller-supplied header → caller
  // body `client_metadata` key → parsed `x-codex-turn-metadata` key → gateway
  // default. So a caller can split its identity across surfaces and we still
  // emit consistent values everywhere.
  const sessionId = trimHeader(opts.headers, 'session-id')
    ?? trimHeader(opts.headers, 'session_id')
    ?? stringField(clientMetadata, 'session_id')
    ?? stringField(clientTurnMetadata, 'session_id')
    ?? await deriveSessionIdFromInput(body)
    ?? uuidV7();
  const threadId = trimHeader(opts.headers, 'thread-id')
    ?? stringField(clientMetadata, 'thread_id')
    ?? stringField(clientTurnMetadata, 'thread_id')
    ?? sessionId;
  const clientRequestId = trimHeader(opts.headers, 'x-client-request-id') ?? threadId;
  const installationId = stringField(clientMetadata, 'x-codex-installation-id')
    ?? stringField(clientTurnMetadata, 'installation_id')
    ?? opts.account.openaiDeviceId;
  const windowId = trimHeader(opts.headers, 'x-codex-window-id')
    ?? stringField(clientMetadata, 'x-codex-window-id')
    ?? stringField(clientTurnMetadata, 'window_id')
    ?? `${sessionId}:0`;
  const turnId = stringField(clientMetadata, 'turn_id')
    ?? stringField(clientTurnMetadata, 'turn_id')
    ?? uuidV7();
  return { installationId, sessionId, threadId, clientRequestId, turnId, windowId };
};

// A stateless caller that re-sends the full conversation every turn would
// otherwise mint a fresh UUIDv7 per request and never hit chatgpt.com's
// prompt cache. Hash `instructions` + every item up to and including the
// first user message so the id is stable across turns of the same
// conversation (subsequent turns append tail items after the first user
// message, so the seed shape is unchanged) and different conversations get
// different ids. Stateful callers using `previous_response_id` reach this
// code path with the input already expanded from the snapshot in
// attempt.ts, so they hash the same prefix as the original turn and get
// the same session id — no server-side session map required.
const deriveSessionIdFromInput = async (body: unknown): Promise<string | null> => {
  if (!isPlainObject(body)) return null;
  const seed = seedUpToFirstUserMessage(body.input);
  if (seed === null) return null;
  const instructions = typeof body.instructions === 'string' ? body.instructions : '';
  // U+0001 separates the two seed components so an empty instructions can't
  // collide with the input prefix via string concatenation.
  return await sha256Uuid(`${instructions}${JSON.stringify(seed)}`);
};

const seedUpToFirstUserMessage = (input: unknown): readonly unknown[] | null => {
  if (typeof input === 'string') return [input];
  if (!Array.isArray(input)) return null;
  const collected: unknown[] = [];
  for (const item of input) {
    collected.push(item);
    if (isUserMessageItem(item)) return collected;
  }
  return null;
};

const isUserMessageItem = (item: unknown): boolean => {
  if (typeof item !== 'object' || item === null) return false;
  const obj = item as { type?: unknown; role?: unknown };
  // Implicit `type: "message"` is valid per the OpenAI Responses schema;
  // explicit non-message items (tool results, reasoning, etc.) skip.
  if (obj.type !== undefined && obj.type !== 'message') return false;
  return obj.role === 'user';
};

const buildCodexTurnMetadata = (
  identity: CodexRequestIdentity,
  options: CodexTurnMetadataOptions,
  clientOverrides: Record<string, unknown> | null,
): Record<string, unknown> => {
  const base: Record<string, unknown> = {
    installation_id: identity.installationId,
    session_id: identity.sessionId,
    thread_id: identity.threadId,
    turn_id: identity.turnId,
    window_id: identity.windowId,
    request_kind: options.requestKind,
  };
  if (options.compaction !== undefined) base.compaction = options.compaction;
  if (clientOverrides === null) return base;
  // Identity-mirror keys already came from `identity`; only carry the
  // caller's extras (turn_started_at_unix_ms, sandbox, workspaces,
  // parent_thread_id, …) into the outgoing blob.
  for (const [k, v] of Object.entries(clientOverrides)) {
    if (!IDENTITY_MIRRORED_TURN_METADATA_KEYS.has(k)) base[k] = v;
  }
  return base;
};

const buildCodexTurnMetadataJson = (
  identity: CodexRequestIdentity,
  options: CodexTurnMetadataOptions,
  clientOverrides: Record<string, unknown> | null,
): string =>
  JSON.stringify(buildCodexTurnMetadata(identity, options, clientOverrides));

const buildCodexClientMetadata = (identity: CodexRequestIdentity, turnMetadataJson: string): Record<string, string> => ({
  'x-codex-installation-id': identity.installationId,
  session_id: identity.sessionId,
  thread_id: identity.threadId,
  'x-codex-window-id': identity.windowId,
  turn_id: identity.turnId,
  'x-codex-turn-metadata': turnMetadataJson,
});

const buildCodexResponsesBody = (
  opts: CallCodexResponsesOptions,
  identity: CodexRequestIdentity,
  turnMetadataJson: string,
): Record<string, unknown> => {
  const callerExtras: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(clientCodexClientMetadata(opts.body))) {
    if (!IDENTITY_MIRRORED_CLIENT_METADATA_KEYS.has(k)) callerExtras[k] = v;
  }
  const body: Record<string, unknown> = {
    ...(opts.body as unknown as Record<string, unknown>),
    model: opts.model.id,
    store: false,
    stream: true,
    client_metadata: {
      ...buildCodexClientMetadata(identity, turnMetadataJson),
      ...callerExtras,
    },
  };
  if (body.prompt_cache_key === undefined) body.prompt_cache_key = identity.threadId;
  return body;
};

const codexTurnMetadataOptions = (opts: CallCodexResponsesOptions): CodexTurnMetadataOptions =>
  opts.turnMetadata ?? (containsCompactionTrigger(opts.body.input) ? CODEX_RESPONSES_COMPACTION_V2_TURN_METADATA : { requestKind: 'turn' });

const containsCompactionTrigger = (input: ResponsesPayload['input']): boolean =>
  Array.isArray(input) && input.some(item => item.type === 'compaction_trigger');

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
  identity: CodexRequestIdentity,
  metadata: CodexTurnMetadataOptions,
  clientTurnMetadata: Record<string, unknown> | null,
): Promise<Response> => {
  const turnMetadataJson = buildCodexTurnMetadataJson(identity, metadata, clientTurnMetadata);
  const headers = new Headers();
  headers.set('authorization', `Bearer ${accessToken}`);
  headers.set('chatgpt-account-id', opts.account.chatgptAccountId);
  headers.set('originator', CODEX_ORIGINATOR);
  headers.set('user-agent', CODEX_USER_AGENT);
  headers.set('accept', accept);
  headers.set('content-type', 'application/json');
  headers.set('session-id', identity.sessionId);
  headers.set('thread-id', identity.threadId);
  headers.set('x-client-request-id', identity.clientRequestId);
  headers.set('x-codex-window-id', identity.windowId);
  headers.set('x-codex-turn-metadata', turnMetadataJson);

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
  const clientTurnMetadata = parseClientTurnMetadataJson(trimHeader(opts.headers, 'x-codex-turn-metadata'));
  const clientMetadata = clientCodexClientMetadata(opts.body);
  const identity = await buildCodexRequestIdentity(opts, opts.body, clientMetadata, clientTurnMetadata);
  const metadata = codexTurnMetadataOptions(opts);
  const turnMetadataJson = buildCodexTurnMetadataJson(identity, metadata, clientTurnMetadata);
  const upstreamFetch = dispatchCodexHttpCall(
    opts,
    accessToken,
    CODEX_RESPONSES_PATH,
    'text/event-stream',
    buildCodexResponsesBody(opts, identity, turnMetadataJson),
    identity,
    metadata,
    clientTurnMetadata,
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
  const clientTurnMetadata = parseClientTurnMetadataJson(trimHeader(opts.headers, 'x-codex-turn-metadata'));
  const clientMetadata = clientCodexClientMetadata(opts.body);
  const identity = await buildCodexRequestIdentity(opts, opts.body, clientMetadata, clientTurnMetadata);
  const metadata = opts.turnMetadata ?? { requestKind: 'compaction' };
  const response = await dispatchCodexHttpCall(
    opts,
    accessToken,
    CODEX_RESPONSES_COMPACT_PATH,
    'application/json',
    { ...opts.body, model: opts.model.id },
    identity,
    metadata,
    clientTurnMetadata,
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
