import type { OpenAIChatCompletionsReasoningItem } from '@floway-dev/protocols/openai-chat-completions';

// OpenAI's Chat Completions spec has no reasoning-text field; upstreams expose
// the same quantity as `reasoning_content` or `reasoning`. Treat both as
// aliases of the gateway's canonical `reasoning_text`, preferring the canonical
// name when an upstream emits more than one.

export interface OpenAIChatCompletionsReasoningDeltaAliases {
  reasoning_text?: string | null;
  reasoning_content?: string | null;
  reasoning?: string | null;
}

// Precedence: `reasoning_text` > `reasoning_content` > `reasoning`. Only a
// non-empty string carries reasoning; a `null` field (an upstream filler
// between reasoning and content chunks) is not reasoning.
export const openAIChatCompletionsScalarReasoningText = (delta: OpenAIChatCompletionsReasoningDeltaAliases): string | undefined => {
  if (typeof delta.reasoning_text === 'string' && delta.reasoning_text.length > 0) return delta.reasoning_text;
  if (typeof delta.reasoning_content === 'string' && delta.reasoning_content.length > 0) return delta.reasoning_content;
  if (typeof delta.reasoning === 'string' && delta.reasoning.length > 0) return delta.reasoning;
  return undefined;
};

export const hasReadableSummary = (item: OpenAIChatCompletionsReasoningItem): boolean => item.summary?.some(part => part.text) === true;
