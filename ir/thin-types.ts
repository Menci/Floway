import type { Tag } from 'cbor-x';

import type { IRJSONValue } from './ir.ts';
import type { AnthropicMessagesAssistantInputContentBlock } from '@floway-dev/protocols/anthropic-messages';
import type { GeminiGenerateContentContent } from '@floway-dev/protocols/gemini-generate-content';
import type { OpenAIChatCompletionsAssistantMessageEx } from '@floway-dev/protocols/openai-chat-completions';
import type { CanonicalOpenAIResponsesInputItem } from '@floway-dev/protocols/openai-responses';

export type IRReferencePart = number | [hashIndex: number, start: number, endExclusive: number];
export type IRReferencePayload = IRReferencePart[];
export type IRTextReference = Omit<Tag, 'value' | 'tag'> & { tag: number; value: IRReferencePayload };
export type IRJSONReference = IRTextReference;
export type IRTextRule = { $text: true };
export type IRJSONRule = { $json: true };
export type IRThinValue<T, R> = T extends null | undefined ? T
  : R extends IRJSONRule ? unknown extends T ? IRJSONValue | IRJSONReference : T | IRJSONReference
    : T extends string ? R extends IRTextRule ? T | IRTextReference : T
      : T extends readonly unknown[] ? R extends readonly [infer Element] ? { [K in keyof T]: IRThinValue<T[K], Element> } : T
        : T extends object ? { [K in keyof T]: K extends keyof R ? IRThinValue<T[K], R[K]> : T[K] } : T;

export type IRThinChatCompletionsItem = IRThinValue<OpenAIChatCompletionsAssistantMessageEx, {
  content: IRTextRule | [{ text: IRTextRule; refusal: IRTextRule }];
  refusal: IRTextRule;
  reasoning: IRTextRule;
  reasoning_text: IRTextRule;
  reasoning_content: IRTextRule;
  reasoning_opaque: IRTextRule;
  function_call: { arguments: IRTextRule };
  tool_calls: [{ function: { arguments: IRTextRule }; custom: { input: IRTextRule } }];
}>;
type IRThinResponsesValue<T> = T extends { type: 'message' } ? IRThinValue<T, { content: IRTextRule | [{ text: IRTextRule; refusal: IRTextRule }] }>
  : T extends { type: 'reasoning' } ? IRThinValue<T, { summary: [{ text: IRTextRule }]; content: [{ text: IRTextRule }]; encrypted_content: IRTextRule }>
    : T extends { type: 'function_call' } ? IRThinValue<T, { arguments: IRTextRule }>
      : T extends { type: 'custom_tool_call' } ? IRThinValue<T, { input: IRTextRule }>
        : T extends { type: 'image_generation_call' } ? IRThinValue<T, { result: IRTextRule }> : T;
export type IRThinResponsesItem = IRThinResponsesValue<CanonicalOpenAIResponsesInputItem>;
type IRThinMessagesValue<T> = T extends { type: 'text' } ? IRThinValue<T, { text: IRTextRule; citations: [{ cited_text: IRTextRule }] }>
  : T extends { type: 'thinking' } ? IRThinValue<T, { thinking: IRTextRule; signature: IRTextRule }>
    : T extends { type: 'redacted_thinking' } ? IRThinValue<T, { data: IRTextRule }>
      : T extends { type: 'tool_use' } ? IRThinValue<T, { input: IRJSONRule }> : T;
export type IRThinMessagesItem = IRThinMessagesValue<AnthropicMessagesAssistantInputContentBlock>;
export type IRThinGenerateContentItem = IRThinValue<GeminiGenerateContentContent, {
  parts: [{ text: IRTextRule; thoughtSignature: IRTextRule; inlineData: { data: IRTextRule }; audioTranscription: { text: IRTextRule }; functionCall: { args: IRJSONRule } }];
}>;
export interface IRReplayItems {
  openaiChatCompletions: OpenAIChatCompletionsAssistantMessageEx[];
  openaiResponses: CanonicalOpenAIResponsesInputItem[];
  anthropicMessages: AnthropicMessagesAssistantInputContentBlock[];
  geminiGenerateContent: GeminiGenerateContentContent[];
}
export interface IRThinItems {
  openaiChatCompletions: IRThinChatCompletionsItem[];
  openaiResponses: IRThinResponsesItem[];
  anthropicMessages: IRThinMessagesItem[];
  geminiGenerateContent: IRThinGenerateContentItem[];
}
export interface IRReferenceTags { text: number; json: number; utf16: number; rawJSON?: number }
