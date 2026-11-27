import { isJsonObject, type JsonObject } from '@floway-dev/protocols/common';
import type { OpenAIChatCompletionsPayloadEx } from '@floway-dev/protocols/openai-chat-completions';

// Mistral rejects unknown fields. Floway also omits metadata because translated
// Claude Code requests can include device and session ids there.
// https://github.com/mistralai/client-python/blob/d3da3bd3c63d0502449e1e765bc2d3c16d0d2f1d/src/mistralai/client/models/chatcompletionrequest.py
const REQUEST_FIELDS = new Set([
  'model', 'messages', 'temperature', 'top_p', 'max_tokens', 'stream', 'stop', 'random_seed',
  'response_format', 'tools', 'tool_choice', 'presence_penalty', 'frequency_penalty', 'min_tokens',
  'repetition_penalty', 'top_k', 'logprobs', 'top_logprobs', 'prompt_logprobs', 'top_prompt_logprobs', 'n',
  'prediction', 'parallel_tool_calls', 'reasoning_effort', 'prompt_mode', 'guardrails', 'prompt_cache_key',
  'service_tier', 'safe_prompt',
]);

const MESSAGE_FIELDS = new Map([
  // https://github.com/mistralai/client-python/blob/d3da3bd3c63d0502449e1e765bc2d3c16d0d2f1d/src/mistralai/client/models/systemmessage.py
  ['system', new Set(['role', 'content'])],
  // https://github.com/mistralai/client-python/blob/d3da3bd3c63d0502449e1e765bc2d3c16d0d2f1d/src/mistralai/client/models/usermessage.py
  ['user', new Set(['role', 'content'])],
  // https://github.com/mistralai/client-python/blob/d3da3bd3c63d0502449e1e765bc2d3c16d0d2f1d/src/mistralai/client/models/assistantmessage.py
  ['assistant', new Set(['role', 'content', 'tool_calls', 'prefix'])],
  // https://github.com/mistralai/client-python/blob/d3da3bd3c63d0502449e1e765bc2d3c16d0d2f1d/src/mistralai/client/models/toolmessage.py
  ['tool', new Set(['role', 'content', 'tool_call_id', 'name'])],
]);

// https://github.com/mistralai/client-python/blob/d3da3bd3c63d0502449e1e765bc2d3c16d0d2f1d/src/mistralai/client/models/toolcall.py
const CALL_FIELDS = new Set(['id', 'type', 'function', 'index']);
// https://github.com/mistralai/client-python/blob/d3da3bd3c63d0502449e1e765bc2d3c16d0d2f1d/src/mistralai/client/models/functioncall.py
const CALL_FUNCTION_FIELDS = new Set(['name', 'arguments']);
// https://github.com/mistralai/client-python/blob/d3da3bd3c63d0502449e1e765bc2d3c16d0d2f1d/src/mistralai/client/models/tool.py
const TOOL_FIELDS = new Set(['type', 'function']);
// https://github.com/mistralai/client-python/blob/d3da3bd3c63d0502449e1e765bc2d3c16d0d2f1d/src/mistralai/client/models/function.py
const TOOL_FUNCTION_FIELDS = new Set(['name', 'description', 'parameters', 'strict']);

const pick = (source: JsonObject, allowed: ReadonlySet<string>): JsonObject => {
  const output: JsonObject = {};
  for (const key of Object.keys(source)) if (allowed.has(key)) output[key] = source[key];
  return output;
};

const narrowFunction = (source: unknown, fields: ReadonlySet<string>, functionFields: ReadonlySet<string>): unknown => {
  if (!isJsonObject(source)) return source;
  const record = pick(source, fields);
  if (isJsonObject(record.function)) record.function = pick(record.function, functionFields);
  return record;
};

const narrowMessage = (message: unknown): unknown => {
  if (!isJsonObject(message) || typeof message.role !== 'string') return message;
  const fields = MESSAGE_FIELDS.get(message.role);
  if (fields === undefined) return message;
  const shaped = pick(message, fields);
  if (message.role === 'assistant' && Array.isArray(shaped.tool_calls)) {
    shaped.tool_calls = shaped.tool_calls.map(call => narrowFunction(call, CALL_FIELDS, CALL_FUNCTION_FIELDS));
  }
  return shaped;
};

export const mistralChatRequest = (payload: OpenAIChatCompletionsPayloadEx): JsonObject => {
  const wire = pick({ ...payload }, REQUEST_FIELDS);
  if (wire.max_tokens === undefined && payload.max_completion_tokens !== undefined) wire.max_tokens = payload.max_completion_tokens;
  if (Array.isArray(wire.messages)) wire.messages = wire.messages.map(narrowMessage);
  if (Array.isArray(wire.tools)) wire.tools = wire.tools.map(tool => narrowFunction(tool, TOOL_FIELDS, TOOL_FUNCTION_FIELDS));
  // The endpoint accepts include_usage and rejects continuous_usage_stats.
  // https://docs.mistral.ai/api/#tag/chat/operation/chat_completion_v1_chat_completions_post
  if (isJsonObject(payload.stream_options) && Object.hasOwn(payload.stream_options, 'include_usage')) {
    wire.stream_options = { include_usage: payload.stream_options.include_usage };
  }
  return wire;
};
