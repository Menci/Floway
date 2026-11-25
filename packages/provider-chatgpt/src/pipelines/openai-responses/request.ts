import type { ChatGPTResponsesBody } from './responses-lite.ts';
import { isObject } from '../../auth/guards.ts';
import { CHATGPT_OPENAI_RESPONSES_COMPACT_PATH, CHATGPT_OPENAI_RESPONSES_PATH, CHATGPT_RESPONSES_LITE_CLIENT_METADATA_KEY, CHATGPT_RESPONSES_LITE_HEADER } from '../../constants.ts';
import { sha256JsonUuid, uuidV7 } from '../../ids.ts';
import { chatgptJsonRequest, stringField, trimHeader } from '../requests.ts';
import type { HttpHeaders, HttpRequestFact } from '@floway-dev/http';
import { toCompactPayloadShape, type CanonicalOpenAIResponsesCompactPayload, type CanonicalOpenAIResponsesInputItem } from '@floway-dev/protocols/openai-responses';

export type ChatGPTResponsesRequestBody = Omit<ChatGPTResponsesBody, 'prompt_cache_options'> & Pick<CanonicalOpenAIResponsesCompactPayload, 'prompt_cache_options'>;

export interface ChatGPTResponsesIdentity {
  installationId: string | null;
  sessionId: string;
  threadId: string;
  clientRequestId: string;
  turnId: string;
  windowId: string;
  callerTurnMetadata: Record<string, unknown> | null;
}

const clientMetadataOf = (body: unknown): Record<string, unknown> =>
  isObject(body) && isObject(body.client_metadata) ? body.client_metadata : {};

const parseTurnMetadata = (raw: string | null): Record<string, unknown> | null => {
  if (raw === null) return null;
  try {
    const value: unknown = JSON.parse(raw);
    return isObject(value) ? value : null;
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    return null;
  }
};

// Codex projects a single per-turn metadata snapshot into headers and body.
// The header belongs to the WebSocket handshake, while the body refreshes each turn.
// https://github.com/openai/codex/blob/a16863f8704831d13e041ed7dba2c4a57a2a940b/codex-rs/core/src/responses_metadata.rs#L184-L189
export const responsesIdentity = (body: ChatGPTResponsesRequestBody, headers: HttpHeaders, compact: boolean): ChatGPTResponsesIdentity => {
  const clientMetadata = clientMetadataOf(body);
  const callerTurnMetadata = parseTurnMetadata(stringField(clientMetadata, 'x-codex-turn-metadata'))
    ?? parseTurnMetadata(trimHeader(headers, 'x-codex-turn-metadata'));
  const sessionId = stringField(clientMetadata, 'session_id')
    ?? stringField(callerTurnMetadata, 'session_id')
    ?? trimHeader(headers, 'session-id')
    ?? trimHeader(headers, 'session_id')
    ?? deriveSessionIdFromInput(body)
    ?? uuidV7();
  const threadId = stringField(clientMetadata, 'thread_id')
    ?? stringField(callerTurnMetadata, 'thread_id')
    ?? trimHeader(headers, 'thread-id')
    ?? sessionId;
  // https://github.com/openai/codex/blob/a16863f8704831d13e041ed7dba2c4a57a2a940b/codex-rs/codex-api/src/endpoint/responses.rs#L87-L96
  // https://github.com/openai/codex/blob/a16863f8704831d13e041ed7dba2c4a57a2a940b/codex-rs/core/src/session/mod.rs#L3684-L3689
  return {
    installationId: stringField(clientMetadata, 'x-codex-installation-id') ?? stringField(callerTurnMetadata, 'installation_id'),
    sessionId,
    threadId,
    clientRequestId: trimHeader(headers, 'x-client-request-id') ?? threadId,
    windowId: stringField(clientMetadata, 'x-codex-window-id') ?? stringField(callerTurnMetadata, 'window_id') ?? trimHeader(headers, 'x-codex-window-id') ?? `${sessionId}:0`,
    turnId: stringField(clientMetadata, 'turn_id') ?? stringField(callerTurnMetadata, 'turn_id') ?? uuidV7(),
    callerTurnMetadata: callerTurnMetadata === null ? null : transmittedTurnMetadata(callerTurnMetadata, compact),
  };
};

// Full-history callers keep a stable prompt-cache key as a conversation grows.
const deriveSessionIdFromInput = (body: ChatGPTResponsesRequestBody): string | null => {
  const firstUser = body.input.findIndex(item => item.type === 'message' && item.role === 'user');
  if (firstUser < 0) return null;
  const seed: readonly CanonicalOpenAIResponsesInputItem[] = body.input.slice(0, firstUser + 1);
  const instructions = typeof body.instructions === 'string' ? body.instructions : '';
  return sha256JsonUuid(seed, `${instructions}\u0001`);
};

// https://github.com/openai/codex/blob/a16863f8704831d13e041ed7dba2c4a57a2a940b/codex-rs/core/src/responses_metadata.rs#L255-L300
const IDENTITY_CLIENT_KEYS = new Set(['x-codex-installation-id', 'session_id', 'thread_id', 'x-codex-window-id', 'turn_id', 'x-codex-turn-metadata']);

const transmittedTurnMetadata = ({
  installation_id: _installation_id,
  session_id: _session_id,
  thread_id: _thread_id,
  turn_id: _turn_id,
  window_id: _window_id,
  ...metadata
}: Record<string, unknown>, compact: boolean): Record<string, unknown> => {
  if (!compact) return metadata;
  const { tool_namespaces_info: _tool_namespaces_info, ...headerMetadata } = metadata;
  return headerMetadata;
};

// https://github.com/openai/codex/blob/3d2ee51ca2d5db578f328aa75e20aa22c0197c9a/codex-rs/core/src/client.rs#L651-L678
const COMPACT_EXTENSION_FIELDS = ['tools', 'parallel_tool_calls', 'reasoning', 'text'] as const;

export const codexResponsesRequest = (
  body: ChatGPTResponsesRequestBody,
  identity: ChatGPTResponsesIdentity,
  model: string,
  installationId: string,
  compact: boolean,
  useResponsesLite: boolean,
): HttpRequestFact => {
  const { sessionId, threadId, clientRequestId, turnId, windowId, callerTurnMetadata } = identity;
  const compactionTrigger = body.input.some(item => item.type === 'compaction_trigger');
  const turn: Record<string, unknown> = {
    installation_id: installationId,
    session_id: sessionId,
    thread_id: threadId,
    turn_id: turnId,
    window_id: windowId,
    request_kind: compact || compactionTrigger ? 'compaction' : 'turn',
  };
  if (!compact && compactionTrigger) {
    turn.compaction = { trigger: 'manual', reason: 'user_requested', implementation: 'responses_compaction_v2', phase: 'standalone_turn', strategy: 'memento' };
  }
  const bodyTurn = { ...turn, ...callerTurnMetadata };
  const { tool_namespaces_info: _unboundedToolInventory, ...headerTurn } = bodyTurn;
  const headers: HttpHeaders = [
    ['session-id', sessionId], ['thread-id', threadId], ['x-client-request-id', clientRequestId],
    ['x-codex-window-id', windowId], ['x-codex-turn-metadata', JSON.stringify(headerTurn)],
  ];
  if (useResponsesLite) headers.push([CHATGPT_RESPONSES_LITE_HEADER, 'true']);

  if (compact) {
    const { prompt_cache_options, ...payload } = body;
    const wire: Record<string, unknown> = { ...toCompactPayloadShape(payload), model };
    if (prompt_cache_options !== undefined) wire.prompt_cache_options = prompt_cache_options;
    for (const key of COMPACT_EXTENSION_FIELDS) {
      if (body[key] !== undefined) wire[key] = body[key];
    }
    return chatgptJsonRequest(CHATGPT_OPENAI_RESPONSES_COMPACT_PATH, 'application/json', headers, wire);
  }

  const callerExtras = Object.fromEntries(Object.entries(clientMetadataOf(body)).filter(([key]) =>
    !IDENTITY_CLIENT_KEYS.has(key) && key !== CHATGPT_RESPONSES_LITE_CLIENT_METADATA_KEY));
  return chatgptJsonRequest(CHATGPT_OPENAI_RESPONSES_PATH, 'text/event-stream', headers, {
    ...body,
    model,
    store: false,
    stream: true,
    client_metadata: {
      'x-codex-installation-id': installationId,
      session_id: sessionId,
      thread_id: threadId,
      'x-codex-window-id': windowId,
      turn_id: turnId,
      'x-codex-turn-metadata': JSON.stringify(bodyTurn),
      ...callerExtras,
    },
    ...(body.prompt_cache_key === undefined ? { prompt_cache_key: threadId } : {}),
  });
};
