import { isObject } from './auth/guards.ts';
import { CHATGPT_RESPONSES_LITE_CLIENT_METADATA_KEY } from './constants.ts';
import { sha256JsonUuid, uuidV7 } from './ids.ts';
import { chatgptModelUsesResponsesLite } from './models.ts';
import { encodeChatGPTResponsesLiteRequest, type ChatGPTResponsesBody, type ChatGPTResponsesLiteRequest } from './responses-lite.ts';
import type { ChatGPTAccountCredential } from './state.ts';
import type { CanonicalOpenAIResponsesInputItem, CanonicalOpenAIResponsesPayload, OpenAIResponsesStreamEventEx } from '@floway-dev/protocols/openai-responses';
import { toCompactPayloadShape } from '@floway-dev/protocols/openai-responses';
import type { ProviderModel } from '@floway-dev/provider';

export interface ChatGPTRequestIdentity {
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

export interface ChatGPTTurnMetadataJson {
  body: string;
  header: string;
}

export interface PreparedChatGPTResponsesRequest {
  identity: ChatGPTRequestIdentity;
  turnMetadataJson: ChatGPTTurnMetadataJson;
  responsesLite: boolean;
  movedFields: ChatGPTResponsesLiteRequest['movedFields'];
  body: Record<string, unknown>;
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

export const trimHeader = (headers: Headers, name: string): string | null => {
  const value = headers.get(name)?.trim() ?? '';
  return value.length > 0 ? value : null;
};

export const stringField = (record: Record<string, unknown> | null, key: string): string | null => {
  if (record === null) return null;
  const value = record[key];
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

const clientChatGPTClientMetadata = (body: unknown): Record<string, unknown> => {
  if (!isObject(body)) return {};
  return isObject(body.client_metadata) ? body.client_metadata : {};
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

const callerTurnMetadata = (headers: Headers, clientMetadata: Record<string, unknown>): Record<string, unknown> | null =>
  parseClientTurnMetadataJson(stringField(clientMetadata, 'x-codex-turn-metadata'))
  ?? parseClientTurnMetadataJson(trimHeader(headers, 'x-codex-turn-metadata'));

const IDENTITY_MIRRORED_TURN_METADATA_KEYS = new Set<string>([
  'installation_id', 'session_id', 'thread_id', 'turn_id', 'window_id',
]);

const IDENTITY_MIRRORED_CLIENT_METADATA_KEYS = new Set<string>([
  'x-codex-installation-id', 'session_id', 'thread_id', 'x-codex-window-id', 'turn_id', 'x-codex-turn-metadata',
]);

const buildChatGPTRequestIdentity = (
  account: Pick<ChatGPTAccountCredential, 'openaiDeviceId'>,
  headers: Headers,
  body: ChatGPTResponsesBody,
  clientMetadata: Record<string, unknown>,
  clientTurnMetadata: Record<string, unknown> | null,
): ChatGPTRequestIdentity => {
  // Identity priority follows Codex's per-turn metadata contract: the current
  // body surfaces outrank frozen WebSocket-upgrade headers.
  const sessionId = stringField(clientMetadata, 'session_id')
    ?? stringField(clientTurnMetadata, 'session_id')
    ?? trimHeader(headers, 'session-id')
    ?? trimHeader(headers, 'session_id')
    ?? deriveSessionIdFromInput(body)
    ?? uuidV7();
  const threadId = stringField(clientMetadata, 'thread_id')
    ?? stringField(clientTurnMetadata, 'thread_id')
    ?? trimHeader(headers, 'thread-id')
    ?? sessionId;
  // https://github.com/openai/codex/blob/a16863f8704831d13e041ed7dba2c4a57a2a940b/codex-rs/codex-api/src/endpoint/responses.rs#L87-L91
  // https://github.com/openai/codex/blob/a16863f8704831d13e041ed7dba2c4a57a2a940b/codex-rs/core/src/client.rs#L1134-L1136
  const clientRequestId = trimHeader(headers, 'x-client-request-id') ?? threadId;
  const installationId = stringField(clientMetadata, 'x-codex-installation-id')
    ?? stringField(clientTurnMetadata, 'installation_id')
    ?? account.openaiDeviceId;
  // https://github.com/openai/codex/blob/a16863f8704831d13e041ed7dba2c4a57a2a940b/codex-rs/core/src/session/mod.rs#L3684-L3689
  const windowId = stringField(clientMetadata, 'x-codex-window-id')
    ?? stringField(clientTurnMetadata, 'window_id')
    ?? trimHeader(headers, 'x-codex-window-id')
    ?? `${sessionId}:0`;
  const turnId = stringField(clientMetadata, 'turn_id')
    ?? stringField(clientTurnMetadata, 'turn_id')
    ?? uuidV7();
  return { installationId, sessionId, threadId, clientRequestId, turnId, windowId };
};

const seedUpToFirstUserMessage = (input: readonly CanonicalOpenAIResponsesInputItem[]): readonly CanonicalOpenAIResponsesInputItem[] | null => {
  const collected: CanonicalOpenAIResponsesInputItem[] = [];
  for (const item of input) {
    collected.push(item);
    if (item.type === 'message' && item.role === 'user') return collected;
  }
  return null;
};

const deriveSessionIdFromInput = (body: ChatGPTResponsesBody): string | null => {
  const seed = seedUpToFirstUserMessage(body.input);
  if (seed === null) return null;
  const instructions = typeof body.instructions === 'string' ? body.instructions : '';
  // U+0001 keeps the instructions and JSON seed components unambiguous in the
  // hash input.
  return sha256JsonUuid(seed, `${instructions}`);
};

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
  for (const [key, value] of Object.entries(clientOverrides)) {
    if (!IDENTITY_MIRRORED_TURN_METADATA_KEYS.has(key)) base[key] = value;
  }
  return base;
};

const HEADER_OMITTED_TURN_METADATA_KEYS = new Set<string>(['tool_namespaces_info']);

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

const buildChatGPTOpenAIResponsesBody = (
  wire: ChatGPTResponsesBody,
  modelKey: string,
  identity: ChatGPTRequestIdentity,
  turnMetadataJson: string,
): Record<string, unknown> => {
  const callerExtras: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(clientChatGPTClientMetadata(wire))) {
    if (!IDENTITY_MIRRORED_CLIENT_METADATA_KEYS.has(key)) callerExtras[key] = value;
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

export const prepareChatGPTResponsesRequest = (options: {
  readonly account: Pick<ChatGPTAccountCredential, 'openaiDeviceId'>;
  readonly model: Pick<ProviderModel, 'id' | 'providerData'>;
  readonly body: Omit<CanonicalOpenAIResponsesPayload, 'model'>;
  readonly headers: Headers;
  readonly action: 'generate' | 'compact';
}): PreparedChatGPTResponsesRequest => {
  const clientMetadata = { ...clientChatGPTClientMetadata(options.body) };
  delete clientMetadata[CHATGPT_RESPONSES_LITE_CLIENT_METADATA_KEY];
  const clientTurnMetadata = callerTurnMetadata(options.headers, clientMetadata);
  const identity = buildChatGPTRequestIdentity(options.account, options.headers, options.body, clientMetadata, clientTurnMetadata);
  const metadata: ChatGPTTurnMetadataOptions = options.action === 'compact'
    ? { requestKind: 'compaction' }
    : options.body.input.some(item => item.type === 'compaction_trigger')
      ? CHATGPT_OPENAI_RESPONSES_COMPACTION_V2_TURN_METADATA
      : { requestKind: 'turn' };
  const turnMetadataJson = buildChatGPTTurnMetadataJson(identity, metadata, clientTurnMetadata);
  const standard = { ...options.body, client_metadata: clientMetadata };
  const responsesLite = chatgptModelUsesResponsesLite(options.model);
  const encoded = responsesLite ? encodeChatGPTResponsesLiteRequest(standard, identity.threadId) : undefined;
  const wire = encoded?.body ?? standard;
  return {
    identity,
    turnMetadataJson,
    responsesLite,
    movedFields: encoded?.movedFields ?? {},
    body: options.action === 'compact'
      ? buildChatGPTOpenAIResponsesCompactBody(wire, options.model.id)
      : buildChatGPTOpenAIResponsesBody(wire, options.model.id, identity, turnMetadataJson.body),
  };
};

export type ChatGPTResponsesEvent = OpenAIResponsesStreamEventEx;
