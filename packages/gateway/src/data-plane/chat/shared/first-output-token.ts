import type { ProtocolFrame } from '@floway-dev/protocols/common';
import type { ChatTargetApi } from '@floway-dev/provider';

// True iff the frame is the first chunk that carries downstream-visible
// output content — a text delta, a tool-call argument delta, or a
// chat-completions chunk with non-empty content / tool_calls. Thinking /
// reasoning chunks, upstream envelope frames, and the `done` sentinel all
// return false. Stateless: the caller tracks whether the "first" fired.
export const isFirstOutputTokenFrame = <T>(frame: ProtocolFrame<T>, targetApi: ChatTargetApi): boolean => {
  if (frame.type === 'done') return false;

  const event = frame.event as Record<string, unknown> & { type?: unknown; choices?: unknown };

  if (targetApi === 'messages') return isMessagesOutputEvent(event);
  if (targetApi === 'responses') return isResponsesOutputEvent(event);
  return isChatCompletionsOutputEvent(event);
};

const isMessagesOutputEvent = (event: Record<string, unknown> & { type?: unknown }): boolean => {
  if (event.type !== 'content_block_delta') return false;
  const delta = (event as { delta?: { type?: unknown } }).delta;
  if (!delta || typeof delta !== 'object') return false;
  const kind = (delta as { type?: unknown }).type;
  return kind === 'text_delta' || kind === 'input_json_delta';
};

const isResponsesOutputEvent = (event: Record<string, unknown> & { type?: unknown }): boolean => {
  const t = event.type;
  if (typeof t !== 'string') return false;
  if (t === 'response.output_text.delta') return true;
  if (t === 'response.function_call_arguments.delta') return true;
  if (t === 'response.refusal.delta') return true;
  return false;
};

const isChatCompletionsOutputEvent = (event: Record<string, unknown> & { choices?: unknown }): boolean => {
  const choices = event.choices;
  if (!Array.isArray(choices) || choices.length === 0) return false;
  const delta = (choices[0] as { delta?: Record<string, unknown> } | undefined)?.delta;
  if (!delta) return false;
  const content = delta.content;
  if (typeof content === 'string' && content.length > 0) return true;
  if (Array.isArray(delta.tool_calls) && delta.tool_calls.length > 0) return true;
  return false;
};
