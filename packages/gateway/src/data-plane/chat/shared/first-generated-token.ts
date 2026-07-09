import type { ProtocolFrame } from '@floway-dev/protocols/common';
import type { ChatTargetApi } from '@floway-dev/provider';

// True when the frame carries any model-generated token — text, tool-call
// arguments, refusal, reasoning, or thinking — but not upstream envelope
// frames (message_start, content_block_start, response.created, …).
// Stateless: the caller tracks whether the first fired.
export const isFirstGeneratedTokenFrame = <T>(frame: ProtocolFrame<T>, targetApi: ChatTargetApi): boolean => {
  if (frame.type === 'done') return false;

  const event = frame.event as Record<string, unknown> & { type?: unknown; choices?: unknown };

  if (targetApi === 'messages') return isMessagesGeneratedEvent(event);
  if (targetApi === 'responses') return isResponsesGeneratedEvent(event);
  return isChatCompletionsGeneratedEvent(event);
};

const isMessagesGeneratedEvent = (event: Record<string, unknown> & { type?: unknown }): boolean => {
  if (event.type !== 'content_block_delta') return false;
  const delta = (event as { delta?: { type?: unknown } }).delta;
  if (!delta || typeof delta !== 'object') return false;
  return (
    delta.type === 'text_delta' ||
    delta.type === 'input_json_delta' ||
    delta.type === 'citations_delta' ||
    delta.type === 'thinking_delta'
  );
};

const isResponsesGeneratedEvent = (event: Record<string, unknown> & { type?: unknown }): boolean => {
  const t = event.type;
  if (typeof t !== 'string') return false;
  if (t === 'response.output_text.delta') return true;
  if (t === 'response.function_call_arguments.delta') return true;
  if (t === 'response.custom_tool_call_input.delta') return true;
  if (t === 'response.refusal.delta') return true;
  if (t === 'response.reasoning_text.delta') return true;
  if (t === 'response.reasoning_summary_text.delta') return true;
  return false;
};

const isChatCompletionsGeneratedEvent = (event: Record<string, unknown> & { choices?: unknown }): boolean => {
  const choices = event.choices;
  if (!Array.isArray(choices) || choices.length === 0) return false;
  const delta = (choices[0] as { delta?: Record<string, unknown> }).delta;
  if (!delta) return false;
  const content = delta.content;
  if (typeof content === 'string' && content.length > 0) return true;
  if (Array.isArray(delta.tool_calls) && delta.tool_calls.length > 0) return true;
  const reasoning = delta.reasoning;
  if (typeof reasoning === 'string' && reasoning.length > 0) return true;
  const reasoningContent = delta.reasoning_content;
  if (typeof reasoningContent === 'string' && reasoningContent.length > 0) return true;
  return false;
};
