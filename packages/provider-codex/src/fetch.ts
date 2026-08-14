import { CodexAccessOnlyCredentialError, ensureCodexAccessToken, invalidateCodexAccessToken, mintCodexAccessToken, type CodexPlanObservation } from './access-token.ts';
import { CodexOAuthSessionTerminatedError } from './auth/oauth.ts';
import { isObject } from './auth/parse-helpers.ts';
import {
  CODEX_BACKEND_BASE,
  CODEX_ALPHA_SEARCH_PATH,
  CODEX_IMAGES_EDITS_PATH,
  CODEX_IMAGES_GENERATIONS_PATH,
  CODEX_ORIGINATOR,
  CODEX_RESPONSES_COMPACT_PATH,
  CODEX_RESPONSES_PATH,
  CODEX_USER_AGENT,
} from './constants.ts';
import { sha256JsonUuid, uuidV7 } from './ids.ts';
import { codexPlanSupportsImages } from './models.ts';
import {
  hasCodexQuotaReading,
  parseCodexQuotaHeaders,
  putCodexQuota,
} from './quota.ts';
import type { CodexAccessTokenEntry, CodexAccountCredential } from './state.ts';
import { isEventStreamMediaType } from '@floway-dev/protocols/common';
import type { ImagesGenerationsPayload } from '@floway-dev/protocols/images';
import type { CanonicalResponsesCompactPayload, CanonicalResponsesPayload, ResponsesCompactionResult, ResponsesInputItem, ResponsesStreamEvent } from '@floway-dev/protocols/responses';
import { parseResponsesStream } from '@floway-dev/protocols/responses';
import { jsonRequestBody, serializeOpenAIImagesEditsJsonPayload, type ImagesEditsRequest, type ProviderCallResult, type ProviderModel, type ProviderStreamResult, streamingProviderCall, type UpstreamCallOptions } from '@floway-dev/provider';

export type ProviderCompactionResult =
  | { ok: true; result: ResponsesCompactionResult; modelKey: string }
  | { ok: false; response: Response; modelKey: string };

// Hooks for repo-side state transitions. Refresh-token rotations and
// terminal-state transitions go through the repo; access-token and quota
// persistence are handled inside their own helpers, which write the same
// state_json row the same way.
export interface CodexCallEffects {
  persistRefreshTokenRotation(newRefreshToken: string): Promise<void>;
  persistTerminalState(state: 'session_terminated' | 'refresh_failed', message: string): Promise<void>;
}

// Account selection shared by Codex backend calls. Every surface uses the same
// OAuth credential, quota state, terminal-session classification, and refresh
// retry contract; each operation owns its wire body and response decoding.
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
  body: Omit<CanonicalResponsesPayload, 'model'>;
}

export interface CallCodexResponsesCompactOptions extends CodexBackendCallBase {
  body: Omit<CanonicalResponsesCompactPayload, 'model' | 'store'>;
}

export interface CallCodexAlphaSearchOptions extends CodexBackendCallBase {
  body: Record<string, unknown>;
}

export interface CallCodexImagesGenerationsOptions extends CodexBackendCallBase {
  body: Omit<ImagesGenerationsPayload, 'model'>;
  // Null when the account identity carries no plan claim; the image gate
  // treats an unknown plan as allowed (fail open).
  fallbackPlanType: string | undefined;
}

export interface CallCodexImagesEditsOptions extends CodexBackendCallBase {
  request: ImagesEditsRequest;
  fallbackPlanType: string | undefined;
}

type CodexResponsesBody = CallCodexResponsesOptions['body'] | CallCodexResponsesCompactOptions['body'];

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

export const callCodexAlphaSearch = async (opts: CallCodexAlphaSearchOptions): Promise<ProviderCallResult> => {
  const requestId = stringField(opts.body, 'id') ?? uuidV7();
  const normalized = { ...opts, body: { ...opts.body, id: requestId } };
  const ready = await prepareCodexCall(normalized);
  if (!ready.ok) return { modelKey: normalized.model.id, response: ready.response };
  return await performAlphaSearchCall(normalized, ready.accessToken, false);
};

export const callCodexImagesGenerations = async (opts: CallCodexImagesGenerationsOptions): Promise<ProviderCallResult> => {
  const ready = await prepareCodexCall(opts);
  if (!ready.ok) return { modelKey: opts.model.id, response: ready.response };
  // An account whose plan is unknown falls back to a fail-open sentinel: the
  // upstream gate only withholds images from an explicitly `free` plan.
  const effectivePlan = accessTokenPlan(ready.accessToken)
    ?? (opts.fallbackPlanType === undefined ? { planType: '' } : { planType: opts.fallbackPlanType });
  if (!codexPlanSupportsImages(effectivePlan.planType)) return imageUnavailableResult(opts.model.id);
  const turnId = trimHeader(opts.headers, 'x-codex-image-turn-id') ?? uuidV7();
  return await performImageCall(opts, ready.accessToken, CODEX_IMAGES_GENERATIONS_PATH, { ...opts.body, model: opts.model.id }, turnId, effectivePlan, false);
};

export const callCodexImagesEdits = async (opts: CallCodexImagesEditsOptions): Promise<ProviderCallResult> => {
  const ready = await prepareCodexCall(opts);
  if (!ready.ok) return { modelKey: opts.model.id, response: ready.response };
  // An account whose plan is unknown falls back to a fail-open sentinel: the
  // upstream gate only withholds images from an explicitly `free` plan.
  const effectivePlan = accessTokenPlan(ready.accessToken)
    ?? (opts.fallbackPlanType === undefined ? { planType: '' } : { planType: opts.fallbackPlanType });
  if (!codexPlanSupportsImages(effectivePlan.planType)) return imageUnavailableResult(opts.model.id);
  const body = await serializeOpenAIImagesEditsJsonPayload(opts.request, opts.model.id);
  const turnId = trimHeader(opts.headers, 'x-codex-image-turn-id') ?? uuidV7();
  return await performImageCall(opts, ready.accessToken, CODEX_IMAGES_EDITS_PATH, body, turnId, effectivePlan, false);
};

const accessTokenPlan = (entry: CodexAccessTokenEntry): CodexPlanObservation | null =>
  entry.planType === undefined
    ? null
    : { planType: entry.planType, observedAt: entry.planObservedAt ?? entry.refreshedAt };

// Pre-fetch gates + initial access-token mint.
const prepareCodexCall = async (opts: CodexBackendCallBase): Promise<{ ok: true; accessToken: CodexAccessTokenEntry } | { ok: false; response: Response }> => {
  if (opts.account.state !== 'active') {
    return { ok: false, response: synthetic503(`Codex upstream is ${opts.account.state}`) };
  }

  try {
    const entry = await ensureCodexAccessToken(opts.upstreamId, opts.account.chatgptAccountId, refresh => mintAccessToken(opts, refresh));
    return { ok: true, accessToken: entry };
  } catch (err) {
    if (err instanceof CodexOAuthSessionTerminatedError) {
      await opts.effects.persistTerminalState('refresh_failed', err.upstreamMessage);
      return { ok: false, response: synthetic503(`Codex refresh failed: ${err.upstreamMessage}`) };
    }
    // An access-only credential with nothing usable left is a configuration
    // problem, not an upstream one, so it reaches the client as our 503 with
    // the re-import instruction rather than as a bare failure.
    if (err instanceof CodexAccessOnlyCredentialError) {
      return { ok: false, response: synthetic503(err.message) };
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

const stringField = (record: Record<string, unknown> | null, key: string): string | null => {
  if (record === null) return null;
  const value = record[key];
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

const clientCodexClientMetadata = (body: unknown): Record<string, unknown> => {
  if (!isObject(body)) return {};
  const candidate = body.client_metadata;
  return isObject(candidate) ? candidate : {};
};

const parseClientTurnMetadataJson = (raw: string | null): Record<string, unknown> | null => {
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return isObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
};

// Codex owns one metadata snapshot per turn and projects it onto three
// surfaces — the request headers, the body's flat `client_metadata` keys, and
// the body's `client_metadata["x-codex-turn-metadata"]` blob — with the blob
// declared canonical and the other two declared "compatibility projections of
// this snapshot, not separate sources of truth":
// https://github.com/openai/codex/blob/a16863f8704831d13e041ed7dba2c4a57a2a940b/codex-rs/core/src/responses_metadata.rs#L184-L189
//
// Only the body surfaces are rebuilt per turn on every transport. The
// WebSocket transport writes its headers once, during the upgrade, and then
// carries many turns of differing `request_kind` and `window_id` over that one
// socket without reconnecting, so reading a header there yields the
// handshake's value for the life of the connection. Resolve the body first and
// keep the header as the fallback for callers that only speak the header
// projection.
const callerTurnMetadata = (opts: CodexBackendCallBase, clientMetadata: Record<string, unknown>): Record<string, unknown> | null =>
  parseClientTurnMetadataJson(stringField(clientMetadata, 'x-codex-turn-metadata'))
    ?? parseClientTurnMetadataJson(trimHeader(opts.headers, 'x-codex-turn-metadata'));

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

const buildCodexRequestIdentity = (
  opts: CodexBackendCallBase,
  body: CodexResponsesBody,
  clientMetadata: Record<string, unknown>,
  clientTurnMetadata: Record<string, unknown> | null,
): CodexRequestIdentity => {
  // Identity priority for every mirrored id follows the same per-turn rule as
  // `callerTurnMetadata`: caller body `client_metadata` key → parsed
  // `x-codex-turn-metadata` key → caller-supplied header → gateway default. So
  // a caller can split its identity across surfaces and we still emit
  // consistent values everywhere, and a long-lived socket's frozen handshake
  // headers never outrank the current turn's body.
  const sessionId = stringField(clientMetadata, 'session_id')
    ?? stringField(clientTurnMetadata, 'session_id')
    ?? trimHeader(opts.headers, 'session-id')
    ?? trimHeader(opts.headers, 'session_id')
    ?? deriveSessionIdFromInput(body)
    ?? uuidV7();
  const threadId = stringField(clientMetadata, 'thread_id')
    ?? stringField(clientTurnMetadata, 'thread_id')
    ?? trimHeader(opts.headers, 'thread-id')
    ?? sessionId;
  // Codex has no `client_metadata` counterpart for this one — both transports
  // send it as a header carrying the thread id, which is immutable for the
  // life of a connection anyway:
  // https://github.com/openai/codex/blob/a16863f8704831d13e041ed7dba2c4a57a2a940b/codex-rs/codex-api/src/endpoint/responses.rs#L87-L91
  // https://github.com/openai/codex/blob/a16863f8704831d13e041ed7dba2c4a57a2a940b/codex-rs/core/src/client.rs#L1134-L1136
  const clientRequestId = trimHeader(opts.headers, 'x-client-request-id') ?? threadId;
  const installationId = stringField(clientMetadata, 'x-codex-installation-id')
    ?? stringField(clientTurnMetadata, 'installation_id')
    ?? opts.account.openaiDeviceId;
  // Codex advances the window on every auto-compaction — the id is
  // `{thread_id}:{auto_compact_window_number}` — and a reused socket carries
  // the advanced value in the frame body alone:
  // https://github.com/openai/codex/blob/a16863f8704831d13e041ed7dba2c4a57a2a940b/codex-rs/core/src/session/mod.rs#L3684-L3689
  const windowId = stringField(clientMetadata, 'x-codex-window-id')
    ?? stringField(clientTurnMetadata, 'window_id')
    ?? trimHeader(opts.headers, 'x-codex-window-id')
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
const deriveSessionIdFromInput = (body: CodexResponsesBody): string | null => {
  const seed = seedUpToFirstUserMessage(body.input);
  if (seed === null) return null;
  const instructions = typeof body.instructions === 'string' ? body.instructions : '';
  // U+0001 keeps the instructions and JSON seed components unambiguous in the
  // hash input.
  return sha256JsonUuid(seed, `${instructions}`);
};

const seedUpToFirstUserMessage = (input: readonly ResponsesInputItem[]): readonly ResponsesInputItem[] | null => {
  const collected: ResponsesInputItem[] = [];
  for (const item of input) {
    collected.push(item);
    if (isUserMessageItem(item)) return collected;
  }
  return null;
};

const isUserMessageItem = (item: ResponsesInputItem): boolean =>
  item.type === 'message' && item.role === 'user';

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

// The blob rides both the body and a header. Codex keeps the unbounded tool
// inventory in the body copy only, "so HTTP and WebSocket compatibility
// headers remain bounded":
// https://github.com/openai/codex/blob/a16863f8704831d13e041ed7dba2c4a57a2a940b/codex-rs/core/src/responses_metadata.rs#L291-L300
const HEADER_OMITTED_TURN_METADATA_KEYS = new Set<string>(['tool_namespaces_info']);

interface CodexTurnMetadataJson {
  body: string;
  header: string;
}

const buildCodexTurnMetadataJson = (
  identity: CodexRequestIdentity,
  options: CodexTurnMetadataOptions,
  clientOverrides: Record<string, unknown> | null,
): CodexTurnMetadataJson => {
  const turnMetadata = buildCodexTurnMetadata(identity, options, clientOverrides);
  return {
    body: JSON.stringify(turnMetadata),
    header: JSON.stringify(Object.fromEntries(
      Object.entries(turnMetadata).filter(([key]) => !HEADER_OMITTED_TURN_METADATA_KEYS.has(key)),
    )),
  };
};

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

// One upstream round-trip with quota-header persistence and terminal-401
// classification. The returned Response is what the caller relays:
//   - 2xx: caller decodes the body (SSE for /responses, JSON for /responses/compact)
//   - 429: quota is already snapshotted; return verbatim
//   - 401: an access-only credential preserves the upstream response verbatim
//     and flips the row terminal, because it has nothing to retry with; on a
//     renewable credential `token_invalidated` maps to a synthetic 503 and any
//     other 401 is rebuilt with a re-readable body so the caller can decide to
//     retry with a fresh access token
//   - other: returned verbatim
const dispatchCodexHttpCall = async (
  opts: CodexBackendCallBase,
  accessToken: string,
  path: string,
  accept: string,
  body: Record<string, unknown>,
  identity: CodexRequestIdentity,
  turnMetadataJson: string | null,
): Promise<Response> => {
  const headers = new Headers();
  headers.set('authorization', `Bearer ${accessToken}`);
  // A null account id omits the header rather than sending an empty one: the
  // upstream reads absence as "whichever account this bearer belongs to".
  if (opts.account.chatgptAccountId !== null) {
    headers.set('chatgpt-account-id', opts.account.chatgptAccountId);
  }
  headers.set('originator', CODEX_ORIGINATOR);
  headers.set('user-agent', CODEX_USER_AGENT);
  headers.set('accept', accept);
  headers.set('content-type', 'application/json');
  headers.set('session-id', identity.sessionId);
  headers.set('thread-id', identity.threadId);
  headers.set('x-client-request-id', identity.clientRequestId);
  headers.set('x-codex-window-id', identity.windowId);
  if (turnMetadataJson !== null) headers.set('x-codex-turn-metadata', turnMetadataJson);

  const response = await opts.call.wrapUpstreamCall(() => opts.call.fetcher(`${CODEX_BACKEND_BASE}${path}`, {
    method: 'POST',
    headers,
    body: jsonRequestBody(body),
    signal: opts.signal,
  }));

  return await classifyCodexHttpResponse(opts, response);
};

const classifyCodexHttpResponse = async (
  opts: CodexBackendCallBase,
  response: Response,
  quotaPolicy: 'always' | 'when-present' = 'always',
): Promise<Response> => {
  if (response.ok) {
    persistCodexQuotaObservation(opts, response, false, quotaPolicy);
    return response;
  }

  if (response.status === 429) {
    persistCodexQuotaObservation(opts, response, true, quotaPolicy);
    return response;
  }

  if (response.status === 401) {
    const bodyText = await response.text();
    const { code, message } = parseUpstreamError(bodyText);
    if (opts.account.refresh_token === null) {
      // An access-only credential cannot recover from a rejected bearer, so
      // the row is marked best-effort — but a storage failure must never
      // replace the upstream status, headers, or body the caller needs to
      // diagnose what happened.
      try {
        await opts.effects.persistTerminalState('session_terminated', message);
      } catch {
        // The upstream response remains authoritative.
      }
      return new Response(bodyText, { status: 401, statusText: response.statusText, headers: response.headers });
    }
    if (code === 'token_invalidated') {
      await opts.effects.persistTerminalState('session_terminated', message);
      return synthetic503(`Codex session terminated: ${message}`);
    }
    return new Response(bodyText, { status: 401, statusText: response.statusText, headers: response.headers });
  }

  return response;
};

const persistCodexQuotaObservation = (
  opts: CodexBackendCallBase,
  response: Response,
  isRateLimited: boolean,
  policy: 'always' | 'when-present',
): void => {
  const snapshot = parseCodexQuotaHeaders(response.headers, { now: new Date(), isRateLimited });
  if (policy === 'when-present' && !hasCodexQuotaReading(snapshot)) return;
  registerBackgroundWrite(opts, putCodexQuota(opts.upstreamId, opts.account.chatgptAccountId, snapshot));
};

const dispatchCodexImageCall = async (
  opts: CodexBackendCallBase,
  accessToken: string,
  path: string,
  body: Record<string, unknown>,
  turnId: string,
): Promise<Response> => {
  const headers = new Headers({
    authorization: `Bearer ${accessToken}`,
    originator: trimHeader(opts.headers, 'originator') ?? CODEX_ORIGINATOR,
    'user-agent': CODEX_USER_AGENT,
    accept: 'application/json',
    'content-type': 'application/json',
    'x-codex-image-turn-id': turnId,
  });
  // A null account id omits the header rather than sending an empty one: the
  // upstream reads absence as "whichever account this bearer belongs to".
  if (opts.account.chatgptAccountId !== null) {
    headers.set('chatgpt-account-id', opts.account.chatgptAccountId);
  }
  const response = await opts.call.wrapUpstreamCall(() => opts.call.fetcher(`${CODEX_BACKEND_BASE}${path}`, {
    method: 'POST',
    headers,
    body: jsonRequestBody(body),
    signal: opts.signal,
  }));
  return await classifyCodexHttpResponse(opts, response, 'when-present');
};

// Recover from a 401 without deleting a sibling's newer credential: invalidate
// only the exact token that failed, reuse a winner already stored by another
// request, otherwise force a fresh coalesced mint. The resulting CAS write is
// awaited because it also resolves the latest plan observation for the retry.
//
// Every call site gates this behind `refresh_token !== null`: an access-only
// credential has nothing to re-mint from, its 401 was already classified as
// terminal in `classifyCodexHttpResponse`, and the verbatim upstream response
// is what reaches the client.
const refreshAccessTokenForRetry = async (
  opts: CodexBackendCallBase,
  failedEntry: CodexAccessTokenEntry,
  fallbackPlan?: CodexPlanObservation,
): Promise<{ ok: true; accessToken: CodexAccessTokenEntry } | { ok: false; response: Response }> => {
  try {
    const retained = await invalidateCodexAccessToken(
      opts.upstreamId,
      opts.account.chatgptAccountId,
      failedEntry.token,
    );
    if (retained !== null) return { ok: true, accessToken: retained };
    const effective = await ensureCodexAccessToken(
      opts.upstreamId,
      opts.account.chatgptAccountId,
      async refreshToken => {
        const minted = await mintAccessToken(opts, refreshToken);
        return mergeRetryPlan(minted, fallbackPlan ?? accessTokenPlan(failedEntry) ?? undefined);
      },
      true,
    );
    return { ok: true, accessToken: effective };
  } catch (err) {
    if (err instanceof CodexOAuthSessionTerminatedError) {
      await opts.effects.persistTerminalState('refresh_failed', err.upstreamMessage);
      return { ok: false, response: synthetic503(`Codex refresh failed: ${err.upstreamMessage}`) };
    }
    throw err;
  }
};

const mergeRetryPlan = (
  entry: CodexAccessTokenEntry,
  fallback: CodexPlanObservation | undefined,
): CodexAccessTokenEntry => {
  if (entry.planType !== undefined || fallback === undefined) return entry;
  return {
    ...entry,
    planType: fallback.planType,
    ...(fallback.observedAt === undefined ? {} : { planObservedAt: fallback.observedAt }),
  };
};

const performStreamingResponsesCall = async (
  opts: CallCodexResponsesOptions,
  accessToken: CodexAccessTokenEntry,
  alreadyRetried: boolean,
): Promise<ProviderStreamResult<ResponsesStreamEvent>> => {
  const clientMetadata = clientCodexClientMetadata(opts.body);
  const clientTurnMetadata = callerTurnMetadata(opts, clientMetadata);
  const identity = buildCodexRequestIdentity(opts, opts.body, clientMetadata, clientTurnMetadata);
  const metadata: CodexTurnMetadataOptions = opts.body.input.some(item => item.type === 'compaction_trigger') ? CODEX_RESPONSES_COMPACTION_V2_TURN_METADATA : { requestKind: 'turn' };
  const turnMetadataJson = buildCodexTurnMetadataJson(identity, metadata, clientTurnMetadata);
  const upstreamFetch = dispatchCodexHttpCall(
    opts,
    accessToken.token,
    CODEX_RESPONSES_PATH,
    'text/event-stream',
    buildCodexResponsesBody(opts, identity, turnMetadataJson.body),
    identity,
    turnMetadataJson.header,
  ).then(ensureSseContentType);

  const result = await streamingProviderCall(upstreamFetch, parseResponsesStream, opts.model.id, opts.signal);

  if (!result.ok && result.response.status === 401 && opts.account.refresh_token !== null && !alreadyRetried) {
    const fresh = await refreshAccessTokenForRetry(opts, accessToken);
    if (!fresh.ok) return { ok: false, modelKey: opts.model.id, response: fresh.response };
    return await performStreamingResponsesCall(opts, fresh.accessToken, true);
  }

  return result;
};

const performUnaryCompactCall = async (
  opts: CallCodexResponsesCompactOptions,
  accessToken: CodexAccessTokenEntry,
  alreadyRetried: boolean,
): Promise<ProviderCompactionResult> => {
  const clientMetadata = clientCodexClientMetadata(opts.body);
  const clientTurnMetadata = callerTurnMetadata(opts, clientMetadata);
  const identity = buildCodexRequestIdentity(opts, opts.body, clientMetadata, clientTurnMetadata);
  const metadata: CodexTurnMetadataOptions = { requestKind: 'compaction' };
  const turnMetadataJson = buildCodexTurnMetadataJson(identity, metadata, clientTurnMetadata);
  const response = await dispatchCodexHttpCall(
    opts,
    accessToken.token,
    CODEX_RESPONSES_COMPACT_PATH,
    'application/json',
    { ...opts.body, model: opts.model.id },
    identity,
    turnMetadataJson.header,
  );

  if (response.status === 401 && opts.account.refresh_token !== null && !alreadyRetried) {
    const fresh = await refreshAccessTokenForRetry(opts, accessToken);
    if (!fresh.ok) return { ok: false, modelKey: opts.model.id, response: fresh.response };
    return await performUnaryCompactCall(opts, fresh.accessToken, true);
  }

  if (!response.ok) return { ok: false, modelKey: opts.model.id, response };

  const result = await response.json() as ResponsesCompactionResult;
  return { ok: true, modelKey: opts.model.id, result };
};

const performAlphaSearchCall = async (
  opts: CallCodexAlphaSearchOptions,
  accessToken: CodexAccessTokenEntry,
  alreadyRetried: boolean,
): Promise<ProviderCallResult> => {
  const requestId = stringField(opts.body, 'id');
  if (requestId === null) throw new Error('Normalized Codex alpha search request is missing id');
  const identity: CodexRequestIdentity = {
    installationId: opts.account.openaiDeviceId,
    sessionId: requestId,
    threadId: requestId,
    clientRequestId: requestId,
    turnId: uuidV7(),
    windowId: `${requestId}:0`,
  };
  const turnMetadataJson = trimHeader(opts.headers, 'x-codex-turn-metadata');
  const response = await dispatchCodexHttpCall(
    opts,
    accessToken.token,
    CODEX_ALPHA_SEARCH_PATH,
    'application/json',
    { ...opts.body, model: opts.model.id },
    identity,
    turnMetadataJson,
  );

  if (response.status === 401 && opts.account.refresh_token !== null && !alreadyRetried) {
    const fresh = await refreshAccessTokenForRetry(opts, accessToken);
    if (!fresh.ok) return { modelKey: opts.model.id, response: fresh.response };
    return await performAlphaSearchCall(opts, fresh.accessToken, true);
  }
  return { modelKey: opts.model.id, response };
};

const performImageCall = async (
  opts: CodexBackendCallBase & { fallbackPlanType: string | undefined },
  accessToken: CodexAccessTokenEntry,
  path: string,
  body: Record<string, unknown>,
  turnId: string,
  effectivePlan: CodexPlanObservation,
  alreadyRetried: boolean,
): Promise<ProviderCallResult> => {
  const response = await dispatchCodexImageCall(opts, accessToken.token, path, body, turnId);
  if (response.status === 401 && opts.account.refresh_token !== null && !alreadyRetried) {
    const fresh = await refreshAccessTokenForRetry(opts, accessToken, effectivePlan);
    if (!fresh.ok) return { modelKey: opts.model.id, response: fresh.response };
    const refreshedPlan = accessTokenPlan(fresh.accessToken) ?? effectivePlan;
    if (!codexPlanSupportsImages(refreshedPlan.planType)) return imageUnavailableResult(opts.model.id);
    return await performImageCall(opts, fresh.accessToken, path, body, turnId, refreshedPlan, true);
  }
  return { modelKey: opts.model.id, response };
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

const imageUnavailableResult = (modelKey: string): ProviderCallResult => ({
  modelKey,
  response: new Response(JSON.stringify({
    error: {
      type: 'image_tools_unavailable',
      message: 'ChatGPT Free accounts do not provide Codex image tools.',
    },
  }), { status: 403, headers: { 'content-type': 'application/json' } }),
});

const synthetic503 = (message: string): Response => new Response(JSON.stringify({ error: { type: 'codex_upstream_unavailable', message } }), {
  status: 503,
  headers: { 'content-type': 'application/json' },
});

// Codex backend serves SSE without setting `content-type: text/event-stream`
// (observed in production: only x-codex-* + standard CDN headers come back).
// The shared `streamingProviderCall` rejects 2xx responses lacking the SSE
// content-type as a contract violation, so we synthesize the header on the
// way through. Body stream is preserved verbatim.
const ensureSseContentType = (response: Response): Response => {
  if (isEventStreamMediaType(response.headers.get('content-type'))) return response;
  const headers = new Headers(response.headers);
  headers.set('content-type', 'text/event-stream');
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
};

// Hand best-effort writes to waitUntil so workerd does not cancel them when
// the streaming response returns; the swallow guards against recoverable
// noise (transient storage errors, a state_json write that lost every one of
// its retries) tripping the request.
const registerBackgroundWrite = (opts: CodexBackendCallBase, write: Promise<void>): void => {
  opts.call.waitUntil(write.catch(() => {}));
};
