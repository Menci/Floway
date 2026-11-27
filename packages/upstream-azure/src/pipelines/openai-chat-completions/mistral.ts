import { isJsonObject } from '@floway-dev/protocols/common';
import type { OpenAIChatCompletionsPayloadEx } from '@floway-dev/protocols/openai-chat-completions';

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

// Mistral accepts include_usage and rejects continuous_usage_stats.
// https://docs.mistral.ai/api/#tag/chat/operation/chat_completion_v1_chat_completions_post
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

const MESSAGE_FIELDS_BY_ROLE = new Map([
  ['system', SYSTEM_MESSAGE_FIELDS],
  ['user', USER_MESSAGE_FIELDS],
  ['assistant', ASSISTANT_MESSAGE_FIELDS],
  ['tool', TOOL_MESSAGE_FIELDS],
]);

type Dict = Record<string, unknown>;

const pick = (source: Dict, allowed: ReadonlySet<string>): Dict => {
  const entries = Object.entries(source);
  const kept = entries.filter(([key]) => allowed.has(key));
  return kept.length === entries.length ? source : Object.fromEntries(kept);
};

const narrowChild = (parent: Dict, key: string, allowed: ReadonlySet<string>): Dict => {
  const child = parent[key];
  if (!isJsonObject(child)) return parent;
  const narrowed = pick(child, allowed);
  return narrowed === child ? parent : { ...parent, [key]: narrowed };
};

const mapChanged = (items: unknown[], narrow: (item: unknown) => unknown): unknown[] => {
  const narrowed = items.map(narrow);
  return narrowed.some((item, index) => item !== items[index]) ? narrowed : items;
};

const narrowToolCall = (toolCall: unknown): unknown =>
  isJsonObject(toolCall) ? narrowChild(pick(toolCall, TOOL_CALL_FIELDS), 'function', FUNCTION_CALL_FIELDS) : toolCall;

const narrowMessage = (message: unknown): unknown => {
  if (!isJsonObject(message) || typeof message.role !== 'string') return message;
  const allowed = MESSAGE_FIELDS_BY_ROLE.get(message.role);
  if (allowed === undefined) return message;
  const narrowed = pick(message, allowed);
  if (message.role !== 'assistant' || !Array.isArray(narrowed.tool_calls)) return narrowed;
  const calls = mapChanged(narrowed.tool_calls, narrowToolCall);
  return calls === narrowed.tool_calls ? narrowed : { ...narrowed, tool_calls: calls };
};

const narrowTool = (tool: unknown): unknown =>
  isJsonObject(tool) ? narrowChild(pick(tool, TOOL_FIELDS), 'function', FUNCTION_FIELDS) : tool;

export const toMistralChatCompletions = (payload: OpenAIChatCompletionsPayloadEx): object => {
  const narrowed = { ...pick(payload, REQUEST_FIELDS) };
  if (narrowed.max_tokens === undefined && payload.max_completion_tokens !== undefined) narrowed.max_tokens = payload.max_completion_tokens;
  if (Array.isArray(narrowed.messages)) narrowed.messages = mapChanged(narrowed.messages, narrowMessage);
  if (Array.isArray(narrowed.tools)) narrowed.tools = mapChanged(narrowed.tools, narrowTool);
  const streamOptions = payload.stream_options;
  if (isJsonObject(streamOptions)) {
    const kept = pick(streamOptions, STREAM_OPTIONS_FIELDS);
    if (Object.keys(kept).length > 0) narrowed.stream_options = kept;
  }
  return narrowed;
};
