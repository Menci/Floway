import type { Tag } from 'cbor-x';

import type { IRJSONValue, IRJSONObject, IRProtocol } from './ir.ts';
import type { AnthropicMessagesAssistantInputContentBlock, AnthropicMessagesAssistantMessage } from '@floway-dev/protocols/anthropic-messages';
import type { GeminiGenerateContentContent, GeminiGenerateContentPart } from '@floway-dev/protocols/gemini-generate-content';
import type { OpenAIChatCompletionsAssistantMessageEx, OpenAIChatCompletionsReasoningItem, OpenAIChatCompletionsToolCallEx } from '@floway-dev/protocols/openai-chat-completions';
import type { CanonicalOpenAIResponsesInputItem } from '@floway-dev/protocols/openai-responses';

export const IR_THIN_TAGS = {
  text: 65_536,
  json: 65_537,
} as const;

export type IATId = string;
export type IATOriginal = string | IRJSONObject;
export type IATRestoration = 'text' | 'json';
export type IATRestorationFor<Original extends IATOriginal> = Original extends string ? 'text' : 'json';

export class IATReference<T extends IATOriginal = IATOriginal> {
  declare readonly value: T;

  constructor(readonly id: IATId) {}
}

export type IRReferencePart = number | [hashIndex: number, start: number, endExclusive: number];
export type IRReferencePayload = IRReferencePart[];
export type IRTextReference = Omit<Tag, 'value' | 'tag'> & { tag: typeof IR_THIN_TAGS.text; value: IRReferencePayload };
export type IRJSONReference = Omit<Tag, 'value' | 'tag'> & { tag: typeof IR_THIN_TAGS.json; value: IRReferencePayload };
export type ThinReference = IRTextReference | IRJSONReference;

export type IRTextRule = { $text: true };
export type IRJSONRule = { $json: true };

type IRTextReferenceFor<Reference> = Reference extends IATReference<infer Original>
  ? Extract<Original, string> extends never ? never : IATReference<Extract<Original, string>>
  : Reference extends ThinReference ? Extract<Reference, IRTextReference> : Reference;
type IRJSONReferenceFor<Reference> = Reference extends IATReference<infer Original>
  ? Extract<Original, IRJSONObject> extends never ? never : IATReference<Extract<Original, IRJSONObject>>
  : Reference extends ThinReference ? Extract<Reference, IRJSONReference> : Reference;

export type IRThinValue<T, Rule, Reference> = T extends null | undefined ? T
  : Rule extends IRTextRule ? T extends string ? T | IRTextReferenceFor<Reference> : T
    : Rule extends IRJSONRule ? unknown extends T ? IRJSONValue | IRJSONReferenceFor<Reference> : T | IRJSONReferenceFor<Reference>
      : T extends readonly unknown[] ? Rule extends readonly [infer Element] ? { [K in keyof T]: IRThinValue<T[K], Element, Reference> } : T
        : T extends object ? Rule extends object ? { [K in keyof T]: K extends keyof Rule ? IRThinValue<T[K], Rule[K], Reference> : T[K] } : T
          : T;

type OpenAIChatCompletionsAssistantTextRule = IRTextRule | [{ text: IRTextRule; refusal: IRTextRule }];
type OpenAIChatCompletionsToolCallRule = [{ function: { arguments: IRTextRule }; custom: { input: IRTextRule } }];
type OpenAIChatCompletionsReasoningRule = [{ summary: [{ text: IRTextRule }] }];
type OpenAIChatCompletionsSelected = 'content' | 'refusal' | 'reasoning' | 'reasoning_text' | 'reasoning_content' | 'reasoning_items' | 'function_call' | 'tool_calls';

export type OpenAIChatCompletionsThinAssistantTurn<Reference> = Omit<OpenAIChatCompletionsAssistantMessageEx, OpenAIChatCompletionsSelected> & {
  role: 'assistant';
  content?: IRThinValue<OpenAIChatCompletionsAssistantMessageEx['content'], OpenAIChatCompletionsAssistantTextRule, Reference>;
  refusal?: IRThinValue<OpenAIChatCompletionsAssistantMessageEx['refusal'], IRTextRule, Reference>;
  reasoning?: IRThinValue<OpenAIChatCompletionsAssistantMessageEx['reasoning'], IRTextRule, Reference>;
  reasoning_text?: IRThinValue<OpenAIChatCompletionsAssistantMessageEx['reasoning_text'], IRTextRule, Reference>;
  reasoning_content?: IRThinValue<OpenAIChatCompletionsAssistantMessageEx['reasoning_content'], IRTextRule, Reference>;
  reasoning_items?: IRThinValue<OpenAIChatCompletionsReasoningItem[], OpenAIChatCompletionsReasoningRule, Reference>;
  function_call?: IRThinValue<NonNullable<OpenAIChatCompletionsAssistantMessageEx['function_call']>, { arguments: IRTextRule }, Reference> | null;
  tool_calls?: IRThinValue<OpenAIChatCompletionsToolCallEx[], OpenAIChatCompletionsToolCallRule, Reference>;
};

type AnthropicMessagesTextBlock = Extract<AnthropicMessagesAssistantInputContentBlock, { type: 'text' }>;
type AnthropicMessagesThinkingBlock = Extract<AnthropicMessagesAssistantInputContentBlock, { type: 'thinking' }>;
type AnthropicMessagesToolUseBlock = Extract<AnthropicMessagesAssistantInputContentBlock, { type: 'tool_use' }>;
type AnthropicMessagesOtherBlock = Exclude<AnthropicMessagesAssistantInputContentBlock, { type: 'text' | 'thinking' | 'tool_use' }>;
type AnthropicMessagesThinBlock<Reference> =
  | IRThinValue<AnthropicMessagesTextBlock, { text: IRTextRule; citations?: [{ cited_text: IRTextRule }] }, Reference>
  | IRThinValue<AnthropicMessagesThinkingBlock, { thinking: IRTextRule }, Reference>
  | IRThinValue<AnthropicMessagesToolUseBlock, { input: IRJSONRule }, Reference>
  | AnthropicMessagesOtherBlock;

export type AnthropicMessagesThinAssistantTurn<Reference> = Omit<AnthropicMessagesAssistantMessage, 'content'> & {
  role: 'assistant';
  content: AnthropicMessagesThinBlock<Reference>[];
};

type OpenAIResponsesThinItem<T, Reference> = T extends { type: 'message' }
  ? IRThinValue<T, { content: IRTextRule | [{ text: IRTextRule; refusal: IRTextRule }] }, Reference>
  : T extends { type: 'reasoning' }
    ? IRThinValue<T, { summary: [{ text: IRTextRule }]; content: [{ text: IRTextRule }] }, Reference>
    : T extends { type: 'function_call' }
      ? IRThinValue<T, { arguments: IRTextRule }, Reference>
      : T extends { type: 'custom_tool_call' }
        ? IRThinValue<T, { input: IRTextRule }, Reference>
        : T extends { type: 'image_generation_call' }
          ? IRThinValue<T, { result: IRTextRule }, Reference>
          : T;

export type OpenAIResponsesThinAssistantTurn<Reference> = OpenAIResponsesThinItem<CanonicalOpenAIResponsesInputItem, Reference>[];

type GeminiThinPart<Reference> = IRThinValue<GeminiGenerateContentPart, {
  text: IRTextRule;
  inlineData: { data: IRTextRule };
  audioTranscription: { text: IRTextRule };
  functionCall: { args: IRJSONRule };
}, Reference>;

export type GeminiGenerateContentThinAssistantTurn<Reference> = (Omit<GeminiGenerateContentContent, 'role' | 'parts'> & {
  role: 'model';
  parts?: GeminiThinPart<Reference>[];
})[];

export interface ThinAssistantTurnByProtocol<Reference> {
  openaiChatCompletions: OpenAIChatCompletionsThinAssistantTurn<Reference>;
  openaiResponses: OpenAIResponsesThinAssistantTurn<Reference>;
  anthropicMessages: AnthropicMessagesThinAssistantTurn<Reference>;
  geminiGenerateContent: GeminiGenerateContentThinAssistantTurn<Reference>;
}

export type ThinAssistantTurn<Reference> = ThinAssistantTurnByProtocol<Reference>[IRProtocol];
export type ThinAssistantTurnFor<Protocol extends IRProtocol, Reference> = ThinAssistantTurnByProtocol<Reference>[Protocol];

export type IRReplayCandidate = string | IRJSONObject;

export type ReplaceIATReferences<T> = T extends IATReference<infer Original> ? Original | (Original extends string ? IRTextReference : IRJSONReference)
  : T extends null | undefined ? T
    : T extends readonly unknown[] ? { [K in keyof T]: ReplaceIATReferences<T[K]> }
      : T extends object ? { [K in keyof T]: ReplaceIATReferences<T[K]> }
        : T;

export type RemoveThinReferences<T> = T extends ThinReference ? never
  : T extends null | undefined ? T
    : T extends readonly unknown[] ? { [K in keyof T]: RemoveThinReferences<T[K]> }
      : T extends object ? { [K in keyof T]: RemoveThinReferences<T[K]> }
        : T;
