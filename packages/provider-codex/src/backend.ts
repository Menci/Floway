import { CodexAccessOnlyCredentialError, codexPlanObservation, ensureCodexAccessToken, invalidateCodexAccessToken, mintCodexAccessToken, type CodexPlanObservation } from './access-token.ts';
import { isObject } from './auth/guards.ts';
import { CodexOAuthSessionTerminatedError } from './auth/oauth.ts';
import { CODEX_RESPONSES_LITE_CLIENT_METADATA_KEY } from './constants.ts';
import { sha256JsonUuid, uuidV7 } from './ids.ts';
import { codexModelUsesResponsesLite } from './models.ts';
import {
  hasCodexQuotaReading,
  parseCodexQuotaHeaders,
  putCodexQuota,
} from './quota.ts';
import {
  encodeCodexResponsesLiteRequest,
  type CodexResponsesBody,
  type CodexResponsesLiteRequest,
} from './responses-lite.ts';
import type { CodexAccessTokenEntry, CodexAccountCredential } from './state.ts';
import type { CanonicalOpenAIResponsesPayload, OpenAIResponsesInputItem } from '@floway-dev/protocols/openai-responses';
import { toCompactPayloadShape } from '@floway-dev/protocols/openai-responses';
import type { ProviderModel, UpstreamCallOptions } from '@floway-dev/provider';

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
export interface CodexBackendCallBase {
  upstreamId: string;
  account: CodexAccountCredential;
  model: Pick<ProviderModel, 'id' | 'providerData'>;
  headers: Headers;
  signal?: AbortSignal;
  effects: CodexCallEffects;
  call: UpstreamCallOptions;
}

interface CodexResponsesContentInput extends Pick<CodexBackendCallBase, 'account' | 'headers' | 'model'> {
  body: Omit<CanonicalOpenAIResponsesPayload, 'model'>;
}

type CodexOpenAIResponsesBody = CodexResponsesBody;

export const prepareCodexCall = async (opts: CodexBackendCallBase): Promise<{ ok: true; accessToken: CodexAccessTokenEntry } | { ok: false; response: Response }> => {
  if (opts.account.state !== 'active') {
    return { ok: false, response: synthetic503(`Codex upstream is ${opts.account.state}`) };
  }

  try {
    const entry = await ensureCodexAccessToken(opts.upstreamId, opts.account.chatgptAccountId, refresh => mintAccessToken(opts, refresh));
    return { ok: true, accessToken: entry };
  } catch (err) {
    if (err instanceof CodexOAuthSessionTerminatedError) return await codexRefreshFailed(opts, err);
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

export const CODEX_OPENAI_RESPONSES_COMPACTION_V2_TURN_METADATA: CodexTurnMetadataOptions = {
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
const callerTurnMetadata = (opts: Pick<CodexBackendCallBase, 'headers'>, clientMetadata: Record<string, unknown>): Record<string, unknown> | null =>
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
  opts: Pick<CodexBackendCallBase, 'headers' | 'account'>,
  body: CodexOpenAIResponsesBody,
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
const deriveSessionIdFromInput = (body: CodexOpenAIResponsesBody): string | null => {
  const seed = seedUpToFirstUserMessage(body.input);
  if (seed === null) return null;
  const instructions = typeof body.instructions === 'string' ? body.instructions : '';
  // U+0001 keeps the instructions and JSON seed components unambiguous in the
  // hash input.
  return sha256JsonUuid(seed, `${instructions}`);
};

const seedUpToFirstUserMessage = (input: readonly OpenAIResponsesInputItem[]): readonly OpenAIResponsesInputItem[] | null => {
  const collected: OpenAIResponsesInputItem[] = [];
  for (const item of input) {
    collected.push(item);
    if (isUserMessageItem(item)) return collected;
  }
  return null;
};

const isUserMessageItem = (item: OpenAIResponsesInputItem): boolean =>
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

export interface PreparedCodexResponsesRequest {
  identity: CodexRequestIdentity;
  turnMetadataJson: CodexTurnMetadataJson;
  lite?: CodexResponsesLiteRequest;
  body: Record<string, unknown>;
}

export const prepareCodexResponsesContent = (
  opts: CodexResponsesContentInput,
  action: 'generate' | 'compact',
): Omit<PreparedCodexResponsesRequest, 'body'> & { body: Record<string, unknown> } => {
  const clientMetadata = { ...clientCodexClientMetadata(opts.body) };
  delete clientMetadata[CODEX_RESPONSES_LITE_CLIENT_METADATA_KEY];
  const clientTurnMetadata = callerTurnMetadata(opts, clientMetadata);
  const identity = buildCodexRequestIdentity(opts, opts.body, clientMetadata, clientTurnMetadata);
  const metadata: CodexTurnMetadataOptions = action === 'compact'
    ? { requestKind: 'compaction' }
    : opts.body.input.some(item => item.type === 'compaction_trigger')
      ? CODEX_OPENAI_RESPONSES_COMPACTION_V2_TURN_METADATA
      : { requestKind: 'turn' };
  const turnMetadataJson = buildCodexTurnMetadataJson(identity, metadata, clientTurnMetadata);
  const standard = { ...opts.body, client_metadata: clientMetadata };
  const lite = codexModelUsesResponsesLite(opts.model)
    ? encodeCodexResponsesLiteRequest(standard, identity.threadId)
    : undefined;
  const wire = lite?.body ?? standard;
  return {
    identity,
    turnMetadataJson,
    lite,
    body: action === 'compact'
      ? buildCodexOpenAIResponsesCompactBody(wire, opts.model.id)
      : buildCodexOpenAIResponsesBody(wire, opts.model.id, identity, turnMetadataJson.body),
  };
};

const buildCodexOpenAIResponsesBody = (
  wire: CodexResponsesBody,
  modelKey: string,
  identity: CodexRequestIdentity,
  turnMetadataJson: string,
): Record<string, unknown> => {
  const callerExtras: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(clientCodexClientMetadata(wire))) {
    if (!IDENTITY_MIRRORED_CLIENT_METADATA_KEYS.has(k)) callerExtras[k] = v;
  }
  const body: Record<string, unknown> = {
    ...wire,
    model: modelKey,
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

// Codex's private compact endpoint accepts these create-only fields in addition
// to the public compact payload. Encode before projecting so relocated tool
// and instruction carriers reach the wire.
// https://github.com/openai/codex/blob/3d2ee51ca2d5db578f328aa75e20aa22c0197c9a/codex-rs/core/src/client.rs#L651-L678
const CODEX_COMPACT_EXTENSION_FIELDS = ['tools', 'parallel_tool_calls', 'reasoning', 'text'] as const;

const buildCodexOpenAIResponsesCompactBody = (
  wire: CodexResponsesBody,
  modelKey: string,
): Record<string, unknown> => {
  const body: Record<string, unknown> = { ...toCompactPayloadShape(wire), model: modelKey };
  for (const field of CODEX_COMPACT_EXTENSION_FIELDS) {
    const value = wire[field];
    if (value !== undefined) body[field] = value;
  }
  return body;
};

export const writeCodexQuotaObservation = (
  opts: CodexBackendCallBase,
  response: Response,
  isRateLimited: boolean,
  policy: 'always' | 'when-present',
): Promise<void> | null => {
  const snapshot = parseCodexQuotaHeaders(response.headers, { now: new Date(), isRateLimited });
  return policy === 'when-present' && !hasCodexQuotaReading(snapshot)
    ? null
    : putCodexQuota(opts.upstreamId, opts.account.chatgptAccountId, snapshot);
};

// Recover from a 401 without deleting a sibling's newer credential: invalidate
// only the exact token that failed, reuse a winner already stored by another
// request, otherwise force a fresh coalesced mint. The resulting CAS write is
// awaited because it also resolves the latest plan observation for the retry.
//
// Every call site gates this behind `refresh_token !== null`: an access-only
// credential has nothing to re-mint from, its 401 was already classified as
// terminal in `observeCodexResponse`, and the verbatim upstream response
// is what reaches the client.
export const refreshAccessTokenForRetry = async (
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
        return mergeRetryPlan(minted, fallbackPlan ?? codexPlanObservation(failedEntry) ?? undefined);
      },
      true,
    );
    return { ok: true, accessToken: effective };
  } catch (err) {
    if (err instanceof CodexOAuthSessionTerminatedError) return await codexRefreshFailed(opts, err);
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

export interface CodexUpstreamError {
  readonly rawText: string;
  readonly body: unknown;
  readonly code: string | null;
  readonly message: string;
}

export const decodeCodexUpstreamError = (rawText: string): CodexUpstreamError => {
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

export const classifyCodexUnauthorizedResponse = async (opts: CodexBackendCallBase, response: Response, parsed: CodexUpstreamError): Promise<Response> => {
  const { rawText, code, message } = parsed;
  if (opts.account.refresh_token === null) {
    return new Response(rawText, { status: 401, statusText: response.statusText, headers: response.headers });
  }
  if (code === 'token_invalidated') {
    await opts.effects.persistTerminalState('session_terminated', message);
    return synthetic503(`Codex session terminated: ${message}`);
  }
  return new Response(rawText, { status: 401, statusText: response.statusText, headers: response.headers });
};

const synthetic503 = (message: string): Response => new Response(JSON.stringify({ error: { type: 'codex_upstream_unavailable', message } }), {
  status: 503,
  headers: { 'content-type': 'application/json' },
});

const codexRefreshFailed = async (opts: CodexBackendCallBase, err: CodexOAuthSessionTerminatedError): Promise<{ ok: false; response: Response }> => {
  await opts.effects.persistTerminalState('refresh_failed', err.upstreamMessage);
  return { ok: false, response: synthetic503(`Codex refresh failed: ${err.upstreamMessage}`) };
};
