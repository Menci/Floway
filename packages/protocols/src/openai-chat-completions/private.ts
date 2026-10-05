import type { OpenAIChatCompletionsAssistantDeltaEx } from './index.ts';
import type { AnthropicMessagesAssistantContentBlock, AnthropicMessagesTextBlock, AnthropicMessagesThinkingBlock } from '../anthropic-messages/index.ts';
import type { CanonicalOpenAIResponsesInputItem, OpenAIResponsesInputMessageEx, OpenAIResponsesInputContent, CanonicalOpenAIResponsesText, OpenAIResponsesInputReasoning, OpenAIResponsesFunctionToolCallItemEx } from '../openai-responses/index.ts';

export const OpenAIChatCompletionsAssistantMessagePrivate = Symbol('OpenAIChatCompletionsAssistantMessagePrivate');
export const OPENAI_CHAT_COMPLETIONS_REASONING_TEXT_FIELDS = ['reasoning', 'reasoning_text', 'reasoning_content'] as const;
export type OpenAIChatCompletionsReasoningTextField = typeof OPENAI_CHAT_COMPLETIONS_REASONING_TEXT_FIELDS[number];

// Half-open UTF-16 code unit offsets, including unpaired surrogates.
export type OpenAIChatCompletionsTextRangeReference = [start: number, end: number];
export type OpenAIChatCompletionsViaOpenAIResponsesThinItem =
  | Exclude<CanonicalOpenAIResponsesInputItem, { type: 'message' | 'reasoning' | 'function_call' }>
  | (Omit<OpenAIResponsesInputMessageEx, 'content'> & (
    { __text: OpenAIChatCompletionsTextRangeReference[]; __contents?: never }
    | { __text?: never; __contents: (Exclude<OpenAIResponsesInputContent, CanonicalOpenAIResponsesText> | (Omit<CanonicalOpenAIResponsesText, 'text'> & { __text: OpenAIChatCompletionsTextRangeReference[] }))[] }
  ))
  | (Omit<OpenAIResponsesInputReasoning, 'summary' | 'content'> & { __summary: OpenAIChatCompletionsTextRangeReference[][]; __content?: OpenAIChatCompletionsTextRangeReference[][] })
  | (Omit<OpenAIResponsesFunctionToolCallItemEx, 'arguments'> & { __index: number });
export type OpenAIChatCompletionsViaAnthropicMessagesThinBlock =
  | Exclude<AnthropicMessagesAssistantContentBlock, { type: 'text' | 'tool_use' | 'thinking' }>
  | (Omit<AnthropicMessagesTextBlock, 'text'> & { __text: OpenAIChatCompletionsTextRangeReference[] })
  | (Omit<Extract<AnthropicMessagesAssistantContentBlock, { type: 'tool_use' }>, 'input'> & { __index: number })
  | (Omit<AnthropicMessagesThinkingBlock, 'thinking'> & { __thinking: OpenAIChatCompletionsTextRangeReference[] });

export type OpenAIChatCompletionsAssistantMessageSidecar = {
  upstreamProtocol: 'openaiChatCompletions';
  textFieldOriginalName?: OpenAIChatCompletionsReasoningTextField;
  extraFields?: Record<string, unknown>;
  toolCallExtraFields?: Record<string, Record<string, unknown>>;
} | {
  upstreamProtocol: 'openaiResponses';
  thinItems: OpenAIChatCompletionsViaOpenAIResponsesThinItem[];
  referencedTextHash: Uint8Array;
} | {
  upstreamProtocol: 'anthropicMessages';
  thinBlocks: OpenAIChatCompletionsViaAnthropicMessagesThinBlock[];
  referencedTextHash: Uint8Array;
};

export interface OpenAIChatCompletionsAssistantMessagePrivate {
  reasoningText?: string;
  sidecar: OpenAIChatCompletionsAssistantMessageSidecar;
}

export type OpenAIChatCompletionsPrivateDelta =
  | { reasoningText: string; sidecar?: never }
  | { sidecar: OpenAIChatCompletionsAssistantMessageSidecar; reasoningText?: never };

export interface OpenAIChatCompletionsPrivateDraft {
  reasoningText?: string;
  sidecar?: OpenAIChatCompletionsAssistantMessageSidecar;
}

export const accumulateOpenAIChatCompletionsPrivate = (state: OpenAIChatCompletionsPrivateDraft, delta: OpenAIChatCompletionsPrivateDelta): void => {
  if (delta.reasoningText !== undefined) {
    if (state.sidecar !== undefined) throw new Error('Private text arrived after the final sidecar');
    state.reasoningText = (state.reasoningText ?? '') + delta.reasoningText;
  } else {
    if (state.sidecar !== undefined) throw new Error('Private stream contains more than one sidecar');
    state.sidecar = delta.sidecar;
  }
};

export const finalizeOpenAIChatCompletionsPrivate = (state: OpenAIChatCompletionsPrivateDraft): OpenAIChatCompletionsAssistantMessagePrivate | undefined => {
  if (state.sidecar !== undefined) return { ...(state.reasoningText !== undefined ? { reasoningText: state.reasoningText } : {}), sidecar: state.sidecar };
  if (state.reasoningText !== undefined) throw new Error('Private stream ended without its final sidecar');
  return undefined;
};

export interface OpenAIChatCompletionsReasoningPreference {
  textFieldName: OpenAIChatCompletionsReasoningTextField;
  reasoningEncapsulationFormat: 'openrouter-reasoning_details' | 'copilot-reasoning_opaque';
}

// Floway uses the same carrier layout for assistant replay data and synthetic affinity.
// https://openrouter.ai/docs/guides/best-practices/reasoning-tokens#reasoning-details
export const createOpenAIChatCompletionsReasoningCarrierDelta = (data: string, preference: OpenAIChatCompletionsReasoningPreference): OpenAIChatCompletionsAssistantDeltaEx =>
  preference.reasoningEncapsulationFormat === 'openrouter-reasoning_details'
    ? { reasoning_details: [{ type: 'reasoning.encrypted', data, format: 'unknown', index: 1 }] }
    : { reasoning_opaque: data };

export interface OpenAIChatCompletionsPrivateCodec {
  encapsulate(value: OpenAIChatCompletionsAssistantMessagePrivate): Promise<string>;
  unencapsulate(data: unknown): Promise<OpenAIChatCompletionsAssistantMessagePrivate | undefined>;
}

export interface OpenAIChatCompletionsPrivateContext {
  readonly codec: OpenAIChatCompletionsPrivateCodec;
  readonly preference: OpenAIChatCompletionsReasoningPreference;
}
