import type { Tag } from 'cbor-x';

import type { IRJSONObject } from '../../ir/types.ts';
import type { AnthropicMessagesAssistantState, AnthropicMessagesThinAssistantTurn } from '../../protocols/anthropic-messages/as-target/assistant-turn.ts';
import type { GeminiGenerateContentAssistantState, GeminiGenerateContentThinAssistantTurn } from '../../protocols/gemini-generate-content/as-target/assistant-turn.ts';
import type { OpenAIChatCompletionsAssistantState, OpenAIChatCompletionsThinAssistantTurn } from '../../protocols/openai-chat-completions/as-target/assistant-turn.ts';
import type { OpenAIResponsesAssistantState, OpenAIResponsesThinAssistantTurn } from '../../protocols/openai-responses/as-target/assistant-turn.ts';

export const THIN_TAGS = {
  text: 65_536,
  json: 65_537,
} as const;

export type ReferencePart = number | [hashIndex: number, start: number, endExclusive: number];
export type TextReference = Omit<Tag, 'value' | 'tag'> & { tag: typeof THIN_TAGS.text; value: ReferencePart[] };
export type JSONReference = Omit<Tag, 'value' | 'tag'> & { tag: typeof THIN_TAGS.json; value: ReferencePart[] };
export type ThinReference = TextReference | JSONReference;

export type TextRule = { $text: true };
export type JSONRule = { $json: true };

export interface ThinStateLeaves {
  readonly text: unknown;
  readonly json: unknown;
}

type TextReferenceFor<Reference> = Reference extends ThinReference ? Extract<Reference, TextReference> : Reference;
type JSONReferenceFor<Reference> = Reference extends ThinReference ? Extract<Reference, JSONReference> : Reference;

export type ThinValue<T, Rule, Reference> = T extends null | undefined ? T
  : Rule extends TextRule ? T extends string ? T | TextReferenceFor<Reference> : T
    : Rule extends JSONRule ? unknown extends T ? IRJSONObject | JSONReferenceFor<Reference> : T | JSONReferenceFor<Reference>
      : T extends readonly unknown[] ? Rule extends readonly [infer Element] ? { [K in keyof T]: ThinValue<T[K], Element, Reference> } : T
        : T extends object ? Rule extends object ? { [K in keyof T]: K extends keyof Rule ? ThinValue<T[K], Rule[K], Reference> : T[K] } : T
          : T;

export type ThinState<T, Rule, States extends ThinStateLeaves> = T extends null | undefined ? never
  : Rule extends TextRule ? T extends string ? States['text'] : never
    : Rule extends JSONRule ? States['json']
      : T extends readonly unknown[] ? Rule extends readonly [infer Element] ? { [K in keyof T]?: ThinState<T[K], Element, States> } : never
        : T extends object ? Rule extends object ? {
          [K in keyof Rule as K extends keyof T ? ThinState<T[K], Rule[K], States> extends never ? never : K : never]?:
          K extends keyof T ? ThinState<T[K], Rule[K], States> : never;
        } extends infer State extends object ? keyof State extends never ? never : State : never : never
          : never;

export interface ThinAssistantTurnByProtocol<Reference> {
  openaiChatCompletions: OpenAIChatCompletionsThinAssistantTurn<Reference>;
  openaiResponses: OpenAIResponsesThinAssistantTurn<Reference>;
  anthropicMessages: AnthropicMessagesThinAssistantTurn<Reference>;
  geminiGenerateContent: GeminiGenerateContentThinAssistantTurn<Reference>;
}

interface AssistantTurnStateByProtocol<States extends ThinStateLeaves> {
  openaiChatCompletions: OpenAIChatCompletionsAssistantState<States>;
  openaiResponses: OpenAIResponsesAssistantState<States>;
  anthropicMessages: AnthropicMessagesAssistantState<States>;
  geminiGenerateContent: GeminiGenerateContentAssistantState<States>;
}

export type ThinAssistantTurnFor<Protocol extends keyof ThinAssistantTurnByProtocol<Reference>, Reference> = ThinAssistantTurnByProtocol<Reference>[Protocol];
export type AssistantTurnStateFor<Protocol extends keyof AssistantTurnStateByProtocol<States>, States extends ThinStateLeaves> = AssistantTurnStateByProtocol<States>[Protocol];

export type ReplayCandidate = string | IRJSONObject;

export const contentHashKey = (hash: Uint8Array): string => Array.from(hash, byte => byte.toString(16).padStart(2, '0')).join('');
