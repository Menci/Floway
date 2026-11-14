import { ChatGPTAccessOnlyCredentialError, chatgptPlanObservation, ensureChatGPTAccessToken, invalidateChatGPTAccessToken, mintChatGPTAccessToken, type ChatGPTPlanObservation } from './access-token.ts';
import { isObject } from './auth/guards.ts';
import { ChatGPTOAuthSessionTerminatedError } from './auth/oauth.ts';
import {
  CHATGPT_BACKEND_BASE,
  CHATGPT_CLI_VERSION,
  CHATGPT_ALPHA_SEARCH_PATH,
  CHATGPT_OPENAI_IMAGES_EDITS_PATH,
  CHATGPT_OPENAI_IMAGES_GENERATIONS_PATH,
  CHATGPT_ORIGINATOR,
  CHATGPT_OPENAI_RESPONSES_COMPACT_PATH,
  CHATGPT_OPENAI_RESPONSES_PATH,
  CHATGPT_RESPONSES_LITE_CLIENT_METADATA_KEY,
  CHATGPT_RESPONSES_LITE_HEADER,
  CHATGPT_USER_AGENT,
} from './constants.ts';
import { sha256JsonUuid, uuidV7 } from './ids.ts';
import { chatgptModelUsesResponsesLite, chatgptPlanSupportsImages } from './models.ts';
import {
  hasChatGPTQuotaReading,
  parseChatGPTQuotaHeaders,
  putChatGPTQuota,
} from './quota.ts';
import {
  encodeChatGPTResponsesLiteRequest,
  projectMovedChatGPTResponsesFields,
  type ChatGPTResponsesBody,
  type ChatGPTResponsesLiteRequest,
} from './responses-lite.ts';
import { restoreChatGPTResponsesOutput } from './responses-output.ts';
import type { ChatGPTAccessTokenEntry, ChatGPTAccountCredential } from './state.ts';
import { isEventStreamMediaType } from '@floway-dev/protocols/common';
import type { OpenAIImagesGenerationsPayload } from '@floway-dev/protocols/openai-images';
import type { CanonicalOpenAIResponsesPayload, OpenAIResponsesCompactionResultEx, CanonicalOpenAIResponsesInputItem, OpenAIResponsesStreamEventEx } from '@floway-dev/protocols/openai-responses';
import { parseOpenAIResponsesStream, toCompactPayloadShape } from '@floway-dev/protocols/openai-responses';
import { jsonRequestBody, serializeOpenAIImagesEditsJsonPayload, type OpenAIImagesEditsRequest, type ProviderCallResult, type ProviderModel, type ProviderStreamResult, type ReplayableBody, streamingProviderCall, type UpstreamCallOptions } from '@floway-dev/provider';

export type ProviderCompactionResult =
  | { ok: true; result: OpenAIResponsesCompactionResultEx; modelKey: string }
  | { ok: false; response: Response; modelKey: string };

// Hooks for repo-side state transitions. Refresh-token rotations and
// terminal-state transitions go through the repo; access-token and quota
// persistence are handled inside their own helpers, which write the same
// state_json row the same way.
export interface ChatGPTCallEffects {
  persistRefreshTokenRotation(newRefreshToken: string): Promise<void>;
  persistTerminalState(state: 'session_terminated' | 'refresh_failed', message: string): Promise<void>;
}

// Account selection shared by ChatGPT backend calls. Every surface uses the same
// OAuth credential, quota state, terminal-session classification, and refresh
// retry contract; each operation owns its wire body and response decoding.
export interface ChatGPTBackendCallBase {
  upstreamId: string;
  account: ChatGPTAccountCredential;
  model: Pick<ProviderModel, 'id' | 'providerData'>;
  headers: Headers;
  signal?: AbortSignal;
  effects: ChatGPTCallEffects;
  call: UpstreamCallOptions;
}

export interface CallChatGPTOpenAIResponsesOptions extends ChatGPTBackendCallBase {
  body: Omit<CanonicalOpenAIResponsesPayload, 'model'>;
}

export interface CallChatGPTOpenAIResponsesCompactOptions extends ChatGPTBackendCallBase {
  body: Omit<CanonicalOpenAIResponsesPayload, 'model'>;
}

export interface CallChatGPTAlphaSearchOptions extends ChatGPTBackendCallBase {
  body: Record<string, unknown>;
}

export interface CallChatGPTOpenAIImagesGenerationsOptions extends ChatGPTBackendCallBase {
  body: Omit<OpenAIImagesGenerationsPayload, 'model'>;
  // Null when the account identity carries no plan claim; the image gate
  // treats an unknown plan as allowed (fail open).
  fallbackPlanType: string | undefined;
}

export interface CallChatGPTOpenAIImagesEditsOptions extends ChatGPTBackendCallBase {
  request: OpenAIImagesEditsRequest;
  fallbackPlanType: string | undefined;
}

type ChatGPTOpenAIResponsesBody = ChatGPTResponsesBody;

export const callChatGPTOpenAIResponses = async (opts: CallChatGPTOpenAIResponsesOptions): Promise<ProviderStreamResult<OpenAIResponsesStreamEventEx>> => {
  const prepared = prepareChatGPTResponsesRequest(opts, 'generate');
  const ready = await prepareChatGPTCall(opts);
  if (!ready.ok) return { ok: false, modelKey: opts.model.id, response: ready.response };
  return await performStreamingOpenAIResponsesCall(opts, prepared, ready.accessToken, false);
};

export const callChatGPTOpenAIResponsesCompact = async (opts: CallChatGPTOpenAIResponsesCompactOptions): Promise<ProviderCompactionResult> => {
  const prepared = prepareChatGPTResponsesRequest(opts, 'compact');
  const ready = await prepareChatGPTCall(opts);
  if (!ready.ok) return { ok: false, modelKey: opts.model.id, response: ready.response };
  return await performUnaryCompactCall(opts, prepared, ready.accessToken, false);
};

export const callChatGPTAlphaSearch = async (opts: CallChatGPTAlphaSearchOptions): Promise<ProviderCallResult> => {
  const requestId = stringField(opts.body, 'id') ?? uuidV7();
  const normalized = { ...opts, body: { ...opts.body, id: requestId } };
  const ready = await prepareChatGPTCall(normalized);
  if (!ready.ok) return { modelKey: normalized.model.id, response: ready.response };
  return await performAlphaSearchCall(normalized, ready.accessToken, false);
};

const prepareChatGPTImageCall = async (opts: ChatGPTBackendCallBase & { fallbackPlanType: string | undefined }): Promise<{ ok: true; accessToken: ChatGPTAccessTokenEntry; effectivePlan: ChatGPTPlanObservation; turnId: string } | { ok: false; response: Response }> => {
  const ready = await prepareChatGPTCall(opts);
  if (!ready.ok) return { ok: false, response: ready.response };
  // An account whose plan is unknown falls back to a fail-open sentinel: the
  // upstream gate only withholds images from an explicitly `free` plan.
  const effectivePlan = chatgptPlanObservation(ready.accessToken)
    ?? (opts.fallbackPlanType === undefined ? { planType: '' } : { planType: opts.fallbackPlanType });
  if (!chatgptPlanSupportsImages(effectivePlan.planType)) return { ok: false, response: imageUnavailableResult(opts.model.id).response };
  const turnId = trimHeader(opts.headers, 'x-codex-image-turn-id') ?? uuidV7();
  return { ok: true, accessToken: ready.accessToken, effectivePlan, turnId };
};

export const callChatGPTOpenAIImagesGenerations = async (opts: CallChatGPTOpenAIImagesGenerationsOptions): Promise<ProviderCallResult> => {
  const prepared = await prepareChatGPTImageCall(opts);
  if (!prepared.ok) return { modelKey: opts.model.id, response: prepared.response };
  const body = { ...opts.body, model: opts.model.id };
  const request: ChatGPTImageCallRequest = { path: CHATGPT_OPENAI_IMAGES_GENERATIONS_PATH, body, turnId: prepared.turnId };
  return await performImageCall(opts, request, prepared.accessToken, prepared.effectivePlan, false);
};

export const callChatGPTOpenAIImagesEdits = async (opts: CallChatGPTOpenAIImagesEditsOptions): Promise<ProviderCallResult> => {
  const prepared = await prepareChatGPTImageCall(opts);
  if (!prepared.ok) return { modelKey: opts.model.id, response: prepared.response };
  const body = await serializeOpenAIImagesEditsJsonPayload(opts.request, opts.model.id);
  const request: ChatGPTImageCallRequest = { path: CHATGPT_OPENAI_IMAGES_EDITS_PATH, body, turnId: prepared.turnId };
  return await performImageCall(opts, request, prepared.accessToken, prepared.effectivePlan, false);
};

export const prepareChatGPTCall = async (opts: ChatGPTBackendCallBase): Promise<{ ok: true; accessToken: ChatGPTAccessTokenEntry } | { ok: false; response: Response }> => {
  if (opts.account.state !== 'active') {
    return { ok: false, response: synthetic503(`ChatGPT upstream is ${opts.account.state}`) };
  }

  try {
    const entry = await ensureChatGPTAccessToken(opts.upstreamId, opts.account.chatgptAccountId, refresh => mintAccessToken(opts, refresh));
    return { ok: true, accessToken: entry };
  } catch (err) {
    if (err instanceof ChatGPTOAuthSessionTerminatedError) return await chatgptRefreshFailed(opts, err);
    // An access-only credential with nothing usable left is a configuration
    // problem, not an upstream one, so it reaches the client as our 503 with
    // the re-import instruction rather than as a bare failure.
    if (err instanceof ChatGPTAccessOnlyCredentialError) {
      return { ok: false, response: synthetic503(err.message) };
    }
    throw err;
  }
};

const mintAccessToken = (opts: ChatGPTBackendCallBase, refreshToken: string) =>
  mintChatGPTAccessToken(refreshToken, opts.call.fetcher, opts.effects.persistRefreshTokenRotation);

interface ChatGPTRequestIdentity {
  installationId: string;
  sessionId: string;
  threadId: string;
  clientRequestId: string;
  turnId: string;
  windowId: string;
}

export interface ChatGPTCompactionTurnMetadata {
  trigger: 'manual' | 'auto';
  reason: 'user_requested' | 'context_limit';
  implementation: 'responses_compact' | 'responses_compaction_v2';
  phase: 'standalone_turn' | 'mid_turn';
  strategy: 'memento';
}

export interface ChatGPTTurnMetadataOptions {
  requestKind: 'turn' | 'compaction';
  compaction?: ChatGPTCompactionTurnMetadata;
}

export const CHATGPT_OPENAI_RESPONSES_COMPACTION_V2_TURN_METADATA: ChatGPTTurnMetadataOptions = {
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

const clientChatGPTClientMetadata = (body: unknown): Record<string, unknown> => {
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
const callerTurnMetadata = (opts: ChatGPTBackendCallBase, clientMetadata: Record<string, unknown>): Record<string, unknown> | null =>
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

const buildChatGPTRequestIdentity = (
  opts: ChatGPTBackendCallBase,
  body: ChatGPTOpenAIResponsesBody,
  clientMetadata: Record<string, unknown>,
  clientTurnMetadata: Record<string, unknown> | null,
): ChatGPTRequestIdentity => {
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
const deriveSessionIdFromInput = (body: ChatGPTOpenAIResponsesBody): string | null => {
  const seed = seedUpToFirstUserMessage(body.input);
  if (seed === null) return null;
  const instructions = typeof body.instructions === 'string' ? body.instructions : '';
  // U+0001 keeps the instructions and JSON seed components unambiguous in the
  // hash input.
  return sha256JsonUuid(seed, `${instructions}`);
};

const seedUpToFirstUserMessage = (input: readonly CanonicalOpenAIResponsesInputItem[]): readonly CanonicalOpenAIResponsesInputItem[] | null => {
  const collected: CanonicalOpenAIResponsesInputItem[] = [];
  for (const item of input) {
    collected.push(item);
    if (isUserMessageItem(item)) return collected;
  }
  return null;
};

const isUserMessageItem = (item: CanonicalOpenAIResponsesInputItem): boolean =>
  item.type === 'message' && item.role === 'user';

const buildChatGPTTurnMetadata = (
  identity: ChatGPTRequestIdentity,
  options: ChatGPTTurnMetadataOptions,
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

interface ChatGPTTurnMetadataJson {
  body: string;
  header: string;
}

const buildChatGPTTurnMetadataJson = (
  identity: ChatGPTRequestIdentity,
  options: ChatGPTTurnMetadataOptions,
  clientOverrides: Record<string, unknown> | null,
): ChatGPTTurnMetadataJson => {
  const turnMetadata = buildChatGPTTurnMetadata(identity, options, clientOverrides);
  return {
    body: JSON.stringify(turnMetadata),
    header: JSON.stringify(Object.fromEntries(
      Object.entries(turnMetadata).filter(([key]) => !HEADER_OMITTED_TURN_METADATA_KEYS.has(key)),
    )),
  };
};

const buildChatGPTClientMetadata = (identity: ChatGPTRequestIdentity, turnMetadataJson: string): Record<string, string> => ({
  'x-codex-installation-id': identity.installationId,
  session_id: identity.sessionId,
  thread_id: identity.threadId,
  'x-codex-window-id': identity.windowId,
  turn_id: identity.turnId,
  'x-codex-turn-metadata': turnMetadataJson,
});

interface PreparedChatGPTResponsesRequest {
  identity: ChatGPTRequestIdentity;
  turnMetadataJson: ChatGPTTurnMetadataJson;
  responsesLite: boolean;
  movedFields: ChatGPTResponsesLiteRequest['movedFields'];
  body: ReplayableBody;
}

const prepareChatGPTResponsesRequest = (
  opts: CallChatGPTOpenAIResponsesOptions | CallChatGPTOpenAIResponsesCompactOptions,
  action: 'generate' | 'compact',
): PreparedChatGPTResponsesRequest => {
  const clientMetadata = { ...clientChatGPTClientMetadata(opts.body) };
  delete clientMetadata[CHATGPT_RESPONSES_LITE_CLIENT_METADATA_KEY];
  const clientTurnMetadata = callerTurnMetadata(opts, clientMetadata);
  const identity = buildChatGPTRequestIdentity(opts, opts.body, clientMetadata, clientTurnMetadata);
  const metadata: ChatGPTTurnMetadataOptions = action === 'compact'
    ? { requestKind: 'compaction' }
    : opts.body.input.some(item => item.type === 'compaction_trigger')
      ? CHATGPT_OPENAI_RESPONSES_COMPACTION_V2_TURN_METADATA
      : { requestKind: 'turn' };
  const turnMetadataJson = buildChatGPTTurnMetadataJson(identity, metadata, clientTurnMetadata);
  const standard = { ...opts.body, client_metadata: clientMetadata };
  const responsesLite = chatgptModelUsesResponsesLite(opts.model);
  const encoded = responsesLite ? encodeChatGPTResponsesLiteRequest(standard, identity.threadId) : undefined;
  const wire = encoded?.body ?? standard;
  return {
    identity,
    turnMetadataJson,
    responsesLite,
    movedFields: encoded?.movedFields ?? {},
    body: jsonRequestBody(action === 'compact'
      ? buildChatGPTOpenAIResponsesCompactBody(wire, opts.model.id)
      : buildChatGPTOpenAIResponsesBody(wire, opts.model.id, identity, turnMetadataJson.body)),
  };
};

const buildChatGPTOpenAIResponsesBody = (
  wire: ChatGPTResponsesBody,
  modelKey: string,
  identity: ChatGPTRequestIdentity,
  turnMetadataJson: string,
): Record<string, unknown> => {
  const callerExtras: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(clientChatGPTClientMetadata(wire))) {
    if (!IDENTITY_MIRRORED_CLIENT_METADATA_KEYS.has(k)) callerExtras[k] = v;
  }
  const body: Record<string, unknown> = {
    ...wire,
    model: modelKey,
    store: false,
    stream: true,
    client_metadata: {
      ...buildChatGPTClientMetadata(identity, turnMetadataJson),
      ...callerExtras,
    },
  };
  if (body.prompt_cache_key === undefined) body.prompt_cache_key = identity.threadId;
  return body;
};

// Codex's private compact endpoint accepts these create-only fields in addition
// to the public compact payload. Encode before projecting so tool and
// instruction carriers reach the wire.
// https://github.com/openai/codex/blob/3d2ee51ca2d5db578f328aa75e20aa22c0197c9a/codex-rs/core/src/client.rs#L651-L678
const CHATGPT_COMPACT_EXTENSION_FIELDS = ['tools', 'parallel_tool_calls', 'reasoning', 'text'] as const;

const buildChatGPTOpenAIResponsesCompactBody = (
  wire: ChatGPTResponsesBody,
  modelKey: string,
): Record<string, unknown> => {
  const body: Record<string, unknown> = { ...toCompactPayloadShape(wire), model: modelKey };
  for (const field of CHATGPT_COMPACT_EXTENSION_FIELDS) {
    const value = wire[field];
    if (value !== undefined) body[field] = value;
  }
  return body;
};

interface ChatGPTHttpCallRequest {
  accessToken: string;
  path: string;
  accept: string;
  body: ReplayableBody;
  identity: ChatGPTRequestIdentity;
  turnMetadataJson: string | null;
  responsesLite: boolean;
}

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
const postChatGPTJson = async (
  opts: ChatGPTBackendCallBase,
  request: {
    path: string;
    accessToken: string;
    body: Record<string, unknown>;
    headers: Headers;
    quotaPolicy: 'always' | 'when-present';
  },
): Promise<Response> => {
  const { path, accessToken, body, headers, quotaPolicy } = request;
  headers.set('authorization', `Bearer ${accessToken}`);
  // A null account id omits the header rather than sending an empty one: the
  // upstream reads absence as "whichever account this bearer belongs to".
  if (opts.account.chatgptAccountId !== null) {
    headers.set('chatgpt-account-id', opts.account.chatgptAccountId);
  }
  const response = await opts.call.wrapUpstreamCall(() => opts.call.fetcher(`${CHATGPT_BACKEND_BASE}${path}`, {
    method: 'POST',
    headers,
    body: jsonRequestBody(body),
    signal: opts.signal,
  }));
  return await classifyChatGPTHttpResponse(opts, response, quotaPolicy);
};

const dispatchChatGPTHttpCall = async (
  opts: ChatGPTBackendCallBase,
  request: ChatGPTHttpCallRequest,
): Promise<Response> => {
  const { accessToken, path, accept, body, identity, turnMetadataJson, responsesLite } = request;
  const headers = new Headers();
  headers.set('authorization', `Bearer ${accessToken}`);
  if (opts.account.chatgptAccountId !== null) {
    headers.set('chatgpt-account-id', opts.account.chatgptAccountId);
  }
  headers.set('originator', CHATGPT_ORIGINATOR);
  headers.set('user-agent', CHATGPT_USER_AGENT);
  headers.set('version', CHATGPT_CLI_VERSION);
  headers.set('accept', accept);
  headers.set('content-type', 'application/json');
  headers.set('session-id', identity.sessionId);
  headers.set('thread-id', identity.threadId);
  headers.set('x-client-request-id', identity.clientRequestId);
  headers.set('x-codex-window-id', identity.windowId);
  if (turnMetadataJson !== null) headers.set('x-codex-turn-metadata', turnMetadataJson);
  if (responsesLite) headers.set(CHATGPT_RESPONSES_LITE_HEADER, 'true');

  const response = await opts.call.wrapUpstreamCall(() => opts.call.fetcher(`${CHATGPT_BACKEND_BASE}${path}`, {
    method: 'POST',
    headers,
    body,
    signal: opts.signal,
  }));

  return await classifyChatGPTHttpResponse(opts, response);
};

export const classifyChatGPTHttpResponse = async (
  opts: ChatGPTBackendCallBase,
  response: Response,
  quotaPolicy: 'always' | 'when-present' = 'always',
): Promise<Response> => {
  if (response.ok) {
    persistChatGPTQuotaObservation(opts, response, false, quotaPolicy);
    return response;
  }

  if (response.status === 429) {
    persistChatGPTQuotaObservation(opts, response, true, quotaPolicy);
    return response;
  }

  if (response.status === 401) {
    return await classifyChatGPTUnauthorizedResponse(opts, response, decodeChatGPTUpstreamError(await response.text()));
  }

  return response;
};

const persistChatGPTQuotaObservation = (
  opts: ChatGPTBackendCallBase,
  response: Response,
  isRateLimited: boolean,
  policy: 'always' | 'when-present',
): void => {
  const snapshot = parseChatGPTQuotaHeaders(response.headers, { now: new Date(), isRateLimited });
  if (policy === 'when-present' && !hasChatGPTQuotaReading(snapshot)) return;
  registerBackgroundWrite(opts, putChatGPTQuota(opts.upstreamId, opts.account.chatgptAccountId, snapshot));
};

const dispatchChatGPTImageCall = async (
  opts: ChatGPTBackendCallBase,
  request: ChatGPTImageCallDispatchRequest,
): Promise<Response> => {
  const { accessToken, path, body, turnId } = request;
  const headers = new Headers({
    originator: trimHeader(opts.headers, 'originator') ?? CHATGPT_ORIGINATOR,
    'user-agent': CHATGPT_USER_AGENT,
    version: CHATGPT_CLI_VERSION,
    accept: 'application/json',
    'content-type': 'application/json',
    'x-codex-image-turn-id': turnId,
  });
  return await postChatGPTJson(opts, { path, accessToken, body, headers, quotaPolicy: 'when-present' });
};

// Recover from a 401 without deleting a sibling's newer credential: invalidate
// only the exact token that failed, reuse a winner already stored by another
// request, otherwise force a fresh coalesced mint. The resulting CAS write is
// awaited because it also resolves the latest plan observation for the retry.
//
// Every call site gates this behind `refresh_token !== null`: an access-only
// credential has nothing to re-mint from, its 401 was already classified as
// terminal in `classifyChatGPTHttpResponse`, and the verbatim upstream response
// is what reaches the client.
export const refreshAccessTokenForRetry = async (
  opts: ChatGPTBackendCallBase,
  failedEntry: ChatGPTAccessTokenEntry,
  fallbackPlan?: ChatGPTPlanObservation,
): Promise<{ ok: true; accessToken: ChatGPTAccessTokenEntry } | { ok: false; response: Response }> => {
  try {
    const retained = await invalidateChatGPTAccessToken(
      opts.upstreamId,
      opts.account.chatgptAccountId,
      failedEntry.token,
    );
    if (retained !== null) return { ok: true, accessToken: retained };
    const effective = await ensureChatGPTAccessToken(
      opts.upstreamId,
      opts.account.chatgptAccountId,
      async refreshToken => {
        const minted = await mintAccessToken(opts, refreshToken);
        return mergeRetryPlan(minted, fallbackPlan ?? chatgptPlanObservation(failedEntry) ?? undefined);
      },
      true,
    );
    return { ok: true, accessToken: effective };
  } catch (err) {
    if (err instanceof ChatGPTOAuthSessionTerminatedError) return await chatgptRefreshFailed(opts, err);
    throw err;
  }
};

// The 401-retry gate's per-call inputs. The dispatchers bundle their access
// token, the response they saw, the recursion switch, and the retry / failure
// callbacks in one object rather than threading six positional arguments.
interface RetryChatGPTAccess401Options<T> {
  accessToken: ChatGPTAccessTokenEntry;
  response: Response | null;
  alreadyRetried: boolean;
  run: (fresh: ChatGPTAccessTokenEntry) => Promise<T>;
  onRefreshFailure: (response: Response) => T;
  fallbackPlan?: ChatGPTPlanObservation;
}

// The 401 retry gate every call dispatcher shares: on a renewable credential
// that has not already been retried, rotate the failed access token and re-run
// the operation once; if the refresh fails, relay the dispatcher's own failure
// result. The gate — a 401 on a credential with a refresh token, not already
// retried — is folded in here, so callers pass the response they saw and only
// branch on the retried outcome. An access-only credential's 401 is already
// classified terminal in `classifyChatGPTHttpResponse`, and the verbatim upstream
// response reaches the client.
const retryChatGPTAccess401 = async <T>(
  opts: ChatGPTBackendCallBase,
  options: RetryChatGPTAccess401Options<T>,
): Promise<{ retried: true; value: T } | { retried: false }> => {
  const { accessToken, response, alreadyRetried, run, onRefreshFailure, fallbackPlan } = options;
  if (response?.status !== 401 || opts.account.refresh_token === null || alreadyRetried) return { retried: false };
  const fresh = await refreshAccessTokenForRetry(opts, accessToken, fallbackPlan);
  if (!fresh.ok) return { retried: true, value: onRefreshFailure(fresh.response) };
  return { retried: true, value: await run(fresh.accessToken) };
};

const mergeRetryPlan = (
  entry: ChatGPTAccessTokenEntry,
  fallback: ChatGPTPlanObservation | undefined,
): ChatGPTAccessTokenEntry => {
  if (entry.planType !== undefined || fallback === undefined) return entry;
  return {
    ...entry,
    planType: fallback.planType,
    ...(fallback.observedAt === undefined ? {} : { planObservedAt: fallback.observedAt }),
  };
};

const performStreamingOpenAIResponsesCall = async (
  opts: CallChatGPTOpenAIResponsesOptions,
  prepared: PreparedChatGPTResponsesRequest,
  accessToken: ChatGPTAccessTokenEntry,
  alreadyRetried: boolean,
): Promise<ProviderStreamResult<OpenAIResponsesStreamEventEx>> => {
  const upstreamFetch = dispatchChatGPTHttpCall(opts, {
    accessToken: accessToken.token,
    path: CHATGPT_OPENAI_RESPONSES_PATH,
    accept: 'text/event-stream',
    body: prepared.body,
    identity: prepared.identity,
    turnMetadataJson: prepared.turnMetadataJson.header,
    responsesLite: prepared.responsesLite,
  }).then(ensureSseContentType);

  const result = await streamingProviderCall(
    upstreamFetch,
    (stream, parserOpts) => {
      const frames = parseOpenAIResponsesStream(stream, parserOpts);
      return restoreChatGPTResponsesOutput(Object.keys(prepared.movedFields).length === 0
        ? frames
        : projectMovedChatGPTResponsesFields(frames, prepared.movedFields));
    },
    opts.model.id,
    opts.signal,
  );

  const attempt = await retryChatGPTAccess401(
    opts,
    {
      accessToken,
      response: result.ok ? null : result.response,
      alreadyRetried,
      run: fresh => performStreamingOpenAIResponsesCall(opts, prepared, fresh, true),
      onRefreshFailure: resp => ({ ok: false as const, modelKey: opts.model.id, response: resp }),
    },
  );
  if (attempt.retried) return attempt.value;

  return result;
};

const performUnaryCompactCall = async (
  opts: CallChatGPTOpenAIResponsesCompactOptions,
  prepared: PreparedChatGPTResponsesRequest,
  accessToken: ChatGPTAccessTokenEntry,
  alreadyRetried: boolean,
): Promise<ProviderCompactionResult> => {
  const response = await dispatchChatGPTHttpCall(opts, {
    accessToken: accessToken.token,
    path: CHATGPT_OPENAI_RESPONSES_COMPACT_PATH,
    accept: 'application/json',
    body: prepared.body,
    identity: prepared.identity,
    turnMetadataJson: prepared.turnMetadataJson.header,
    responsesLite: prepared.responsesLite,
  });

  const attempt = await retryChatGPTAccess401(
    opts,
    {
      accessToken,
      response,
      alreadyRetried,
      run: fresh => performUnaryCompactCall(opts, prepared, fresh, true),
      onRefreshFailure: resp => ({ ok: false as const, modelKey: opts.model.id, response: resp }),
    },
  );
  if (attempt.retried) return attempt.value;

  if (!response.ok) return { ok: false, modelKey: opts.model.id, response };

  const result = await response.json() as OpenAIResponsesCompactionResultEx;
  return {
    ok: true,
    modelKey: opts.model.id,
    result,
  };
};

const performAlphaSearchCall = async (
  opts: CallChatGPTAlphaSearchOptions,
  accessToken: ChatGPTAccessTokenEntry,
  alreadyRetried: boolean,
): Promise<ProviderCallResult> => {
  const requestId = stringField(opts.body, 'id');
  if (requestId === null) throw new Error('Normalized ChatGPT alpha search request is missing id');
  const identity: ChatGPTRequestIdentity = {
    installationId: opts.account.openaiDeviceId,
    sessionId: requestId,
    threadId: requestId,
    clientRequestId: requestId,
    turnId: uuidV7(),
    windowId: `${requestId}:0`,
  };
  const turnMetadataJson = trimHeader(opts.headers, 'x-codex-turn-metadata');
  const response = await dispatchChatGPTHttpCall(opts, {
    accessToken: accessToken.token,
    path: CHATGPT_ALPHA_SEARCH_PATH,
    accept: 'application/json',
    body: jsonRequestBody({ ...opts.body, model: opts.model.id }),
    identity,
    turnMetadataJson,
    responsesLite: false,
  });

  const attempt = await retryChatGPTAccess401(
    opts,
    {
      accessToken,
      response,
      alreadyRetried,
      run: fresh => performAlphaSearchCall(opts, fresh, true),
      onRefreshFailure: resp => ({ modelKey: opts.model.id, response: resp }),
    },
  );
  if (attempt.retried) return attempt.value;
  return { modelKey: opts.model.id, response };
};

// The fixed per-request inputs for one ChatGPT image call. The path, body, and
// turn id are stable for the whole call, so the entry sites bundle them once
// and retries re-pass the same bundle rather than threading three positional
// arguments on every recursion.
interface ChatGPTImageCallRequest {
  path: string;
  body: Record<string, unknown>;
  turnId: string;
}

// The image-call bundle plus the resolved bearer, mirroring ChatGPTHttpCallRequest
// for the HTTP call path. The entry sites bundle the stable path/body/turnId
// once; retries re-pass the same bundle with a fresh access token rather than
// threading four positional arguments on every recursion.
type ChatGPTImageCallDispatchRequest = ChatGPTImageCallRequest & { accessToken: string };

const performImageCall = async (
  opts: ChatGPTBackendCallBase,
  request: ChatGPTImageCallRequest,
  accessToken: ChatGPTAccessTokenEntry,
  effectivePlan: ChatGPTPlanObservation,
  alreadyRetried: boolean,
): Promise<ProviderCallResult> => {
  const response = await dispatchChatGPTImageCall(opts, { accessToken: accessToken.token, ...request });
  const attempt = await retryChatGPTAccess401(
    opts,
    {
      accessToken,
      response,
      alreadyRetried,
      run: async entry => {
        const refreshedPlan = chatgptPlanObservation(entry) ?? effectivePlan;
        if (!chatgptPlanSupportsImages(refreshedPlan.planType)) return imageUnavailableResult(opts.model.id);
        return await performImageCall(opts, request, entry, refreshedPlan, true);
      },
      onRefreshFailure: resp => ({ modelKey: opts.model.id, response: resp }),
      fallbackPlan: effectivePlan,
    },
  );
  if (attempt.retried) return attempt.value;
  return { modelKey: opts.model.id, response };
};

export interface ChatGPTUpstreamError {
  readonly rawText: string;
  readonly body: unknown;
  readonly code: string | null;
  readonly message: string;
}

export const decodeChatGPTUpstreamError = (rawText: string): ChatGPTUpstreamError => {
  let body: unknown;
  try {
    body = JSON.parse(rawText);
  } catch {
    return { rawText, body: rawText, code: null, message: rawText.slice(0, 256) };
  }
  const obj = typeof body === 'object' && body !== null ? body as { error?: { code?: unknown; message?: unknown }; detail?: unknown } : undefined;
  const code = obj?.error && typeof obj.error === 'object' && typeof obj.error.code === 'string' ? obj.error.code : null;
  const message = obj?.error && typeof obj.error === 'object' && typeof obj.error.message === 'string'
    ? obj.error.message
    : typeof obj?.detail === 'string' ? obj.detail : rawText.slice(0, 256);
  return { rawText, body, code, message };
};

export const classifyChatGPTUnauthorizedResponse = async (opts: ChatGPTBackendCallBase, response: Response, parsed: ChatGPTUpstreamError): Promise<Response> => {
  const { rawText, code, message } = parsed;
  if (opts.account.refresh_token === null) {
    // Access-only credentials retain the authoritative upstream reply even when
    // the terminal-state write fails.
    try {
      await opts.effects.persistTerminalState('session_terminated', message);
    } catch {
      // The upstream response remains authoritative.
    }
    return new Response(rawText, { status: 401, statusText: response.statusText, headers: response.headers });
  }
  if (code === 'token_invalidated') {
    await opts.effects.persistTerminalState('session_terminated', message);
    return synthetic503(`ChatGPT session terminated: ${message}`);
  }
  return new Response(rawText, { status: 401, statusText: response.statusText, headers: response.headers });
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

const synthetic503 = (message: string): Response => new Response(JSON.stringify({ error: { type: 'chatgpt_upstream_unavailable', message } }), {
  status: 503,
  headers: { 'content-type': 'application/json' },
});

const chatgptRefreshFailed = async (opts: ChatGPTBackendCallBase, err: ChatGPTOAuthSessionTerminatedError): Promise<{ ok: false; response: Response }> => {
  await opts.effects.persistTerminalState('refresh_failed', err.upstreamMessage);
  return { ok: false, response: synthetic503(`ChatGPT refresh failed: ${err.upstreamMessage}`) };
};

// Codex backend serves SSE without setting `content-type: text/event-stream`
// (observed in production: only x-codex-* + standard CDN headers come back).
// The shared `streamingProviderCall` rejects 2xx responses lacking the SSE
// content-type as a contract violation, so we synthesize the header on the
// way through. Body stream is preserved verbatim.
const ensureSseContentType = (response: Response): Response => {
  if (!response.ok || isEventStreamMediaType(response.headers.get('content-type'))) return response;
  const headers = new Headers(response.headers);
  headers.set('content-type', 'text/event-stream');
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
};

// Hand best-effort writes to waitUntil so workerd does not cancel them when
// the streaming response returns; the swallow guards against recoverable
// noise (transient storage errors, a state_json write that lost every one of
// its retries) tripping the request.
const registerBackgroundWrite = (opts: ChatGPTBackendCallBase, write: Promise<void>): void => {
  opts.call.waitUntil(write.catch(() => {}));
};
