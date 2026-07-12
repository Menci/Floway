import type { ProtocolFrame } from '@floway-dev/protocols/common';
import type { ChatTargetApi } from '@floway-dev/provider';

// True when the frame carries any model-generated token — text, tool-call
// arguments, refusal, reasoning, or thinking — but not upstream envelope
// frames (message_start, content_block_start, response.created, …).
// Stateless: the caller tracks whether the first fired.
export const isFirstOutputTokenFrame = <T>(frame: ProtocolFrame<T>, targetApi: ChatTargetApi): boolean => {
  if (frame.type === 'done') return false;

  const event = frame.event as Record<string, unknown> & { type?: unknown; choices?: unknown };

  if (targetApi === 'messages') return isMessagesOutputEvent(event);
  if (targetApi === 'responses') return isResponsesOutputEvent(event);
  return isChatCompletionsOutputEvent(event);
};

const nonEmptyString = (value: unknown): value is string => typeof value === 'string' && value.length > 0;

const isMessagesOutputEvent = (event: Record<string, unknown> & { type?: unknown }): boolean => {
  if (event.type !== 'content_block_delta') return false;
  const delta = (event as { delta?: Record<string, unknown> & { type?: unknown } }).delta;
  if (!delta || typeof delta !== 'object') return false;
  switch (delta.type) {
  case 'text_delta': return nonEmptyString(delta.text);
  case 'thinking_delta': return nonEmptyString(delta.thinking);
  case 'input_json_delta': return nonEmptyString(delta.partial_json);
  case 'citations_delta': return delta.citation !== undefined;
  default: return false;
  }
};

const RESPONSES_OUTPUT_EVENT_TYPES = new Set([
  'response.output_text.delta',
  'response.function_call_arguments.delta',
  'response.custom_tool_call_input.delta',
  'response.refusal.delta',
  'response.reasoning_text.delta',
  'response.reasoning_summary_text.delta',
]);

const isResponsesOutputEvent = (event: Record<string, unknown> & { type?: unknown }): boolean => {
  if (typeof event.type !== 'string' || !RESPONSES_OUTPUT_EVENT_TYPES.has(event.type)) return false;
  return nonEmptyString((event as { delta?: unknown }).delta);
};

const isChatCompletionsOutputEvent = (event: Record<string, unknown> & { choices?: unknown }): boolean => {
  const choices = event.choices;
  if (!Array.isArray(choices) || choices.length === 0) return false;
  const delta = (choices[0] as { delta?: Record<string, unknown> }).delta;
  if (!delta) return false;
  if (nonEmptyString(delta.content)) return true;
  if (Array.isArray(delta.tool_calls) && delta.tool_calls.length > 0) return true;
  if (nonEmptyString(delta.refusal)) return true;
  if (nonEmptyString(delta.reasoning)) return true;
  if (nonEmptyString(delta.reasoning_content)) return true;
  if (nonEmptyString(delta.reasoning_text)) return true;
  return false;
};
