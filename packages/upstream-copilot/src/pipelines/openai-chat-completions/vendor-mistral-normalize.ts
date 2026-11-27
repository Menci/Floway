import { defineCopilotStage } from '../facts.ts';
import type { OpenAIChatCompletionsPayloadEx } from '@floway-dev/protocols/openai-chat-completions';

// Mistral validates the request against a strict schema and spells the output cap max_tokens.
// https://docs.mistral.ai/api/#tag/chat/operation/chat_completion_v1_chat_completions_post
// ChatCompletionRequest:
// https://github.com/mistralai/client-python/blob/d3da3bd3c63d0502449e1e765bc2d3c16d0d2f1d/src/mistralai/client/models/chatcompletionrequest.py
// The SDK also defines `metadata`, but it is deliberately left out: Floway's
// translation forwards the client's metadata, and Claude Code puts its
// device and session identifiers in `metadata.user_id`; Floway does not hand
// those to Mistral.
const REQUEST_FIELDS = new Set([
  'model', 'messages', 'temperature', 'top_p', 'max_tokens', 'stream', 'stop', 'random_seed',
  'response_format', 'tools', 'tool_choice', 'presence_penalty', 'frequency_penalty', 'min_tokens',
  'repetition_penalty', 'top_k', 'logprobs', 'top_logprobs', 'prompt_logprobs', 'top_prompt_logprobs', 'n',
  'prediction', 'parallel_tool_calls', 'reasoning_effort', 'prompt_mode', 'guardrails', 'prompt_cache_key',
  'service_tier', 'safe_prompt',
]);

// Not in the SDK model; kept because the server accepts it (see above).
const STREAM_OPTIONS_FIELDS = new Set(['include_usage']);

// SystemMessage:
// https://github.com/mistralai/client-python/blob/d3da3bd3c63d0502449e1e765bc2d3c16d0d2f1d/src/mistralai/client/models/systemmessage.py
const SYSTEM_MESSAGE_FIELDS = new Set(['role', 'content']);
// UserMessage:
// https://github.com/mistralai/client-python/blob/d3da3bd3c63d0502449e1e765bc2d3c16d0d2f1d/src/mistralai/client/models/usermessage.py
const USER_MESSAGE_FIELDS = new Set(['role', 'content']);
// AssistantMessage:
// https://github.com/mistralai/client-python/blob/d3da3bd3c63d0502449e1e765bc2d3c16d0d2f1d/src/mistralai/client/models/assistantmessage.py
const ASSISTANT_MESSAGE_FIELDS = new Set(['role', 'content', 'tool_calls', 'prefix']);
// ToolMessage:
// https://github.com/mistralai/client-python/blob/d3da3bd3c63d0502449e1e765bc2d3c16d0d2f1d/src/mistralai/client/models/toolmessage.py
const TOOL_MESSAGE_FIELDS = new Set(['role', 'content', 'tool_call_id', 'name']);
// ToolCall:
// https://github.com/mistralai/client-python/blob/d3da3bd3c63d0502449e1e765bc2d3c16d0d2f1d/src/mistralai/client/models/toolcall.py
const TOOL_CALL_FIELDS = new Set(['id', 'type', 'function', 'index']);
// FunctionCall:
// https://github.com/mistralai/client-python/blob/d3da3bd3c63d0502449e1e765bc2d3c16d0d2f1d/src/mistralai/client/models/functioncall.py
const FUNCTION_CALL_FIELDS = new Set(['name', 'arguments']);
// Tool:
// https://github.com/mistralai/client-python/blob/d3da3bd3c63d0502449e1e765bc2d3c16d0d2f1d/src/mistralai/client/models/tool.py
const TOOL_FIELDS = new Set(['type', 'function']);
// Function:
// https://github.com/mistralai/client-python/blob/d3da3bd3c63d0502449e1e765bc2d3c16d0d2f1d/src/mistralai/client/models/function.py
const FUNCTION_FIELDS = new Set(['name', 'description', 'parameters', 'strict']);

const MESSAGE_FIELDS_BY_ROLE: Record<string, ReadonlySet<string>> = {
  system: SYSTEM_MESSAGE_FIELDS,
  user: USER_MESSAGE_FIELDS,
  assistant: ASSISTANT_MESSAGE_FIELDS,
  tool: TOOL_MESSAGE_FIELDS,
};

type Dict = Record<string, unknown>;

const isDict = (value: unknown): value is Dict => typeof value === 'object' && value !== null && !Array.isArray(value);

const pick = (source: Dict, allowed: ReadonlySet<string>): Dict => {
  const out: Dict = {};
  for (const key of Object.keys(source)) if (allowed.has(key)) out[key] = source[key];
  return out;
};

// Narrows a nested object under `key` in place of the parent's copy.
const narrowChild = (parent: Dict, key: string, allowed: ReadonlySet<string>): Dict => {
  const child = parent[key];
  return isDict(child) ? { ...parent, [key]: pick(child, allowed) } : parent;
};

const narrowToolCall = (toolCall: unknown): unknown =>
  isDict(toolCall) ? narrowChild(pick(toolCall, TOOL_CALL_FIELDS), 'function', FUNCTION_CALL_FIELDS) : toolCall;

const narrowMessage = (message: unknown): unknown => {
  if (!isDict(message) || typeof message.role !== 'string') return message;
  const allowed = MESSAGE_FIELDS_BY_ROLE[message.role];
  if (allowed === undefined) return message;
  const narrowed = pick(message, allowed);
  if (message.role === 'assistant' && Array.isArray(narrowed.tool_calls)) narrowed.tool_calls = narrowed.tool_calls.map(narrowToolCall);
  return narrowed;
};

const narrowTool = (tool: unknown): unknown =>
  isDict(tool) ? narrowChild(pick(tool, TOOL_FIELDS), 'function', FUNCTION_FIELDS) : tool;

const narrowPayload = (payload: OpenAIChatCompletionsPayloadEx): OpenAIChatCompletionsPayloadEx => {
  const source = payload as Dict;
  const narrowed = pick(source, REQUEST_FIELDS);
  if (narrowed.max_tokens === undefined && source.max_completion_tokens !== undefined) narrowed.max_tokens = source.max_completion_tokens;
  if (Array.isArray(narrowed.messages)) narrowed.messages = narrowed.messages.map(narrowMessage);
  if (Array.isArray(narrowed.tools)) narrowed.tools = narrowed.tools.map(narrowTool);
  const streamOptions = source.stream_options;
  if (isDict(streamOptions)) {
    const kept = pick(streamOptions, STREAM_OPTIONS_FIELDS);
    if (Object.keys(kept).length > 0) narrowed.stream_options = kept;
  }
  return narrowed as OpenAIChatCompletionsPayloadEx;
};

export const normalizeMistral = defineCopilotStage({
  name: 'copilot.openaiChatCompletions.normalizeMistral',
  through: {
    request: { needs: ['model', 'openaiChatCompletions'], provides: ['openaiChatCompletions'], consumes: [] },
    response: { needs: [], provides: [], consumes: [] },
  },
  async execute(facts, scope) {
    if (!facts.model.enabledFlags.includes('vendor-mistral')) return await scope.next(facts);
    return await scope.next({ ...facts, openaiChatCompletions: narrowPayload(facts.openaiChatCompletions) });
  },
});
