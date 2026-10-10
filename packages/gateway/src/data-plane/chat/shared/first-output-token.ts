import type { AnthropicMessagesContentBlockDeltaEvent, AnthropicMessagesContentBlockStartEvent } from '@floway-dev/protocols/anthropic-messages';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import type { OpenAIChatCompletionsAssistantDeltaEx, OpenAIChatCompletionsReasoningItem, OpenAIChatCompletionsStreamEvent } from '@floway-dev/protocols/openai-chat-completions';
import type { OpenAIResponsesOutputItemEx, OpenAIResponsesStreamEventEx } from '@floway-dev/protocols/openai-responses';
import type { ChatTargetApi } from '@floway-dev/provider';

export const isFirstOutputTokenFrame = <T>(frame: ProtocolFrame<T>, targetApi: ChatTargetApi): boolean => {
  if (frame.type === 'done') return false;

  const event = frame.event as Record<string, unknown>;
  if (targetApi === 'anthropicMessages') return isAnthropicMessagesOutputEvent(event);
  if (targetApi === 'openaiResponses') return isOpenAIResponsesOutputEvent(event);
  return isOpenAIChatCompletionsOutputEvent(event);
};

const nonEmptyString = (value: unknown): value is string => typeof value === 'string' && value.length > 0;

const isAnthropicMessagesOutputEvent = (event: Record<string, unknown>): boolean => {
  // A tool name can arrive before its streamed JSON input; it is already model output.
  // https://platform.claude.com/docs/en/build-with-claude/streaming#input-json-delta
  if (event.type === 'content_block_start') {
    const block = event.content_block as AnthropicMessagesContentBlockStartEvent['content_block'] | undefined;
    if (!block) return false;
    switch (block.type) {
    case 'tool_use':
    case 'server_tool_use': return nonEmptyString(block.name);
    case 'text': return nonEmptyString(block.text);
    case 'thinking': return nonEmptyString(block.thinking);
    default: return false;
    }
  }
  if (event.type !== 'content_block_delta') return false;
  const delta = event.delta as AnthropicMessagesContentBlockDeltaEvent['delta'] | undefined;
  if (!delta) return false;
  switch (delta.type) {
  case 'text_delta': return nonEmptyString(delta.text);
  case 'thinking_delta': return nonEmptyString(delta.thinking);
  case 'input_json_delta': return nonEmptyString(delta.partial_json);
  case 'citations_delta': return delta.citation !== undefined;
  // Compaction is a separate inference iteration, excluded from the top-level
  // output token count used by performance telemetry.
  // https://github.com/anthropics/anthropic-sdk-python/blob/b4b7916deaf4e5570cd627b1ae7ee4394a4de39f/src/anthropic/types/beta/beta_usage.py#L50-L56
  case 'compaction_delta': return false;
  default: return false;
  }
};

// All currently modeled string deltas carry generated content. The exhaustive
// record forces additions to the protocol union to be classified here too.
// https://github.com/openai/openai-python/tree/ef676dbc199bc09d12a1d051f3b8b2486aa53dc2/src/openai/types/responses
// Tool execution output has an object delta and must not start model timing.
// https://github.com/openai/openai-python/blob/ef676dbc199bc09d12a1d051f3b8b2486aa53dc2/src/openai/types/responses/response_shell_call_output_content_delta_event.py#L12-L38
const OPENAI_RESPONSES_OUTPUT_EVENT_TYPES = new Set(Object.keys({
  'response.output_text.delta': true,
  'response.function_call_arguments.delta': true,
  'response.custom_tool_call_input.delta': true,
  'response.refusal.delta': true,
  'response.reasoning.delta': true,
  'response.reasoning_text.delta': true,
  'response.reasoning_summary_text.delta': true,
  'response.audio.delta': true,
  'response.audio.transcript.delta': true,
  'response.code_interpreter_call_code.delta': true,
  'response.mcp_call_arguments.delta': true,
  'response.shell_call_command.delta': true,
  'response.apply_patch_call_operation_diff.delta': true,
} satisfies Record<Extract<OpenAIResponsesStreamEventEx, { delta: string }>['type'], true>));

const isOpenAIResponsesOutputEvent = (event: Record<string, unknown>): boolean => {
  // Function names are generated content even when arguments have not arrived.
  // https://github.com/openai/openai-python/blob/ef676dbc199bc09d12a1d051f3b8b2486aa53dc2/src/openai/types/responses/response_function_tool_call.py
  if (event.type === 'response.output_item.added') {
    const item = event.item as OpenAIResponsesOutputItemEx | undefined;
    return (item?.type === 'function_call' || item?.type === 'custom_tool_call' || item?.type === 'mcp_call') && nonEmptyString(item.name);
  }
  if (typeof event.type !== 'string' || !OPENAI_RESPONSES_OUTPUT_EVENT_TYPES.has(event.type)) return false;
  return nonEmptyString(event.delta);
};

// Tool identity fields are envelopes; names and input are generated output.
// https://github.com/openai/openai-python/blob/ef676dbc199bc09d12a1d051f3b8b2486aa53dc2/src/openai/types/chat/chat_completion_chunk.py#L37-L79
const hasToolCallOutput = (call: { function?: { name?: string; arguments?: string }; custom?: { name?: string; input?: string } }): boolean =>
  nonEmptyString(call.function?.name) || nonEmptyString(call.function?.arguments)
  || nonEmptyString(call.custom?.name) || nonEmptyString(call.custom?.input);

// Readable reasoning can stream exclusively in structured carriers. Signatures
// and encrypted replay data alone do not establish a generated-text boundary.
// https://github.com/OpenRouterTeam/docs/blob/427f46bb902c41b6c475dc46e9541c2c4ab9cc90/guides/best-practices/reasoning-tokens.mdx
const hasReasoningDetailsOutput = (details: unknown): boolean => Array.isArray(details) && details.some((detail: { type?: string; text?: string; summary?: string }) =>
  (detail.type === 'reasoning.text' && nonEmptyString(detail.text))
  || (detail.type === 'reasoning.summary' && nonEmptyString(detail.summary)));

const hasReasoningItemsOutput = (items: unknown): boolean => Array.isArray(items) && items.some((item: OpenAIChatCompletionsReasoningItem) =>
  item.type === 'reasoning' && item.summary?.some(part => nonEmptyString(part.text)) === true);

const isOpenAIChatCompletionsOutputEvent = (event: Record<string, unknown>): boolean => {
  const choices = event.choices as OpenAIChatCompletionsStreamEvent['choices'] | undefined;
  return Array.isArray(choices) && choices.some(choice => {
    const delta = choice.delta as OpenAIChatCompletionsAssistantDeltaEx | undefined;
    if (!delta) return false;
    return nonEmptyString(delta.content) || nonEmptyString(delta.refusal)
      || nonEmptyString(delta.reasoning) || nonEmptyString(delta.reasoning_content) || nonEmptyString(delta.reasoning_text)
      || nonEmptyString(delta.audio?.data) || nonEmptyString(delta.audio?.transcript)
      || (delta.function_call !== undefined && hasToolCallOutput({ function: delta.function_call }))
      || delta.tool_calls?.some(hasToolCallOutput) === true
      || hasReasoningDetailsOutput(delta.reasoning_details) || hasReasoningItemsOutput(delta.reasoning_items);
  });
};
