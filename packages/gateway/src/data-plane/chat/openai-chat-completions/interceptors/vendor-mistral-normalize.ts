// Mistral wire-dialect normalizer for OpenAI Chat Completions. Always-attached;
// flag-gated by `vendor-mistral`. Runs last among the gateway's interceptors so
// it has the final say on the outbound wire body.
//
// Mistral validates its request body strictly (pydantic `extra=forbid`) and
// answers `422 extra_forbidden` for any key its schema does not list, e.g.
// `stream_options.continuous_usage_stats` or a replayed assistant turn's
// `refusal` / `index` / `reasoning_content`. OpenAI-compatible upstreams
// tolerate those keys, so the gateway keeps them canonical and this
// interceptor narrows the outbound payload to the fields Mistral defines.
//
// Outbound (request → upstream): drop every key that is not in the field lists
// below, at the top level, on each message (by role), on assistant `tool_calls`
// entries and their `function` objects, and on `tools` entries and their
// `function` objects. Values are never rewritten: `content` stays a string or
// a list of chunks, and the remaining nested objects (`parameters`,
// `response_format`, ...) pass through verbatim. Messages of a role Mistral
// does not define (e.g. `developer`) are left as they are.
//
// The one renamed field is the output cap. Translation onto Chat Completions
// states it only as OpenAI's current `max_completion_tokens` (#724),
// which Mistral's schema does not define; Mistral spells it `max_tokens`, so
// the value moves there instead of being dropped with the unknown key. A
// `max_tokens` the request already carries wins.
//
// Inbound: unchanged; this interceptor does not touch the response side.
//
// `stream_options` is absent from Mistral's SDK request model, but the server
// accepts `{ include_usage: true }` (a live request carrying both keys was
// rejected naming only `continuous_usage_stats`), so `include_usage` is the one
// key kept.
//
// Reference (client-python at commit d3da3bd3c63d0502449e1e765bc2d3c16d0d2f1d):
// - https://docs.mistral.ai/api/#tag/chat/operation/chat_completion_v1_chat_completions_post

import type { OpenAIChatCompletionsInterceptor } from './types.ts';
import type { OpenAIChatCompletionsPayload } from '@floway-dev/protocols/openai-chat-completions';
import { providerModelOf } from '@floway-dev/provider';

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

export const withVendorMistralOpenAIChatCompletionsNormalize: OpenAIChatCompletionsInterceptor = async (ctx, _gatewayCtx, run) => {
  if (!providerModelOf(ctx.candidate).enabledFlags.has('vendor-mistral')) return await run();

  const source = ctx.payload as unknown as Dict;
  const narrowed = pick(source, REQUEST_FIELDS);
  if (narrowed.max_tokens === undefined && source.max_completion_tokens !== undefined) narrowed.max_tokens = source.max_completion_tokens;
  if (Array.isArray(narrowed.messages)) narrowed.messages = narrowed.messages.map(narrowMessage);
  if (Array.isArray(narrowed.tools)) narrowed.tools = narrowed.tools.map(narrowTool);
  const streamOptions = source.stream_options;
  if (isDict(streamOptions)) {
    const kept = pick(streamOptions, STREAM_OPTIONS_FIELDS);
    if (Object.keys(kept).length > 0) narrowed.stream_options = kept;
  }
  ctx.payload = narrowed as unknown as OpenAIChatCompletionsPayload;

  return await run();
};
