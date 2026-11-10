import type { IRJSONObject } from '../../ir/types.ts';
import type { AnthropicMessagesAssistantState, AnthropicMessagesReferenceableAssistantTurn } from '../../protocols/anthropic-messages/as-target/assistant-turn.ts';
import type { GeminiGenerateContentAssistantState, GeminiGenerateContentReferenceableAssistantTurn } from '../../protocols/gemini-generate-content/as-target/assistant-turn.ts';
import type { OpenAIChatCompletionsAssistantState, OpenAIChatCompletionsReferenceableAssistantTurn } from '../../protocols/openai-chat-completions/as-target/assistant-turn.ts';
import type { OpenAIResponsesAssistantState, OpenAIResponsesReferenceableAssistantTurn } from '../../protocols/openai-responses/as-target/assistant-turn.ts';

export type ContentReferenceSegment = number | [hashIndex: number, start: number, endExclusive: number];

// Thin references are translate's compact form for replayed content. The
// injected sidecar codec only sees their transport representation.
export class ContentReference<Kind extends 'text' | 'json' = 'text' | 'json'> {
  constructor(
    readonly kind: Kind,
    public parts: ContentReferenceSegment[],
  ) {}
}

export type TextReference = ContentReference<'text'>;
export type JSONReference = ContentReference<'json'>;

export type TextRule = { $text: true };
export type JSONRule = { $json: true };

export interface ReferenceStateLeaves {
  readonly text: unknown;
  readonly json: unknown;
}

type TextReferenceFor<Reference> = Reference extends ContentReference ? Extract<TextReference, Reference> : Reference;
type JSONReferenceFor<Reference> = Reference extends ContentReference ? Extract<JSONReference, Reference> : Reference;

export type ReferenceableValue<T, Rule, Reference> = T extends null | undefined ? T
  : Rule extends TextRule ? T extends string ? T | TextReferenceFor<Reference> : T
    : Rule extends JSONRule ? unknown extends T ? IRJSONObject | JSONReferenceFor<Reference> : T | JSONReferenceFor<Reference>
      : T extends readonly unknown[] ? Rule extends readonly [infer Element] ? { [K in keyof T]: ReferenceableValue<T[K], Element, Reference> } : T
        : T extends object ? Rule extends object ? { [K in keyof T]: K extends keyof Rule ? ReferenceableValue<T[K], Rule[K], Reference> : T[K] } : T
          : T;

export type ReferenceState<T, Rule, States extends ReferenceStateLeaves> = T extends null | undefined ? never
  : Rule extends TextRule ? T extends string ? States['text'] : never
    : Rule extends JSONRule ? States['json']
      : T extends readonly unknown[] ? Rule extends readonly [infer Element] ? { [K in keyof T]?: ReferenceState<T[K], Element, States> } : never
        : T extends object ? Rule extends object ? {
          [K in keyof Rule as K extends keyof T ? ReferenceState<T[K], Rule[K], States> extends never ? never : K : never]?:
          K extends keyof T ? ReferenceState<T[K], Rule[K], States> : never;
        } extends infer State extends object ? keyof State extends never ? never : State : never : never
          : never;

interface ReferenceableAssistantTurnByProtocol<Reference> {
  openaiChatCompletions: OpenAIChatCompletionsReferenceableAssistantTurn<Reference>;
  openaiResponses: OpenAIResponsesReferenceableAssistantTurn<Reference>;
  anthropicMessages: AnthropicMessagesReferenceableAssistantTurn<Reference>;
  geminiGenerateContent: GeminiGenerateContentReferenceableAssistantTurn<Reference>;
}

interface AssistantTurnStateByProtocol<States extends ReferenceStateLeaves> {
  openaiChatCompletions: OpenAIChatCompletionsAssistantState<States>;
  openaiResponses: OpenAIResponsesAssistantState<States>;
  anthropicMessages: AnthropicMessagesAssistantState<States>;
  geminiGenerateContent: GeminiGenerateContentAssistantState<States>;
}

export type ReferenceableAssistantTurnFor<Protocol extends keyof ReferenceableAssistantTurnByProtocol<Reference>, Reference> = ReferenceableAssistantTurnByProtocol<Reference>[Protocol];
export type AssistantTurnStateFor<Protocol extends keyof AssistantTurnStateByProtocol<States>, States extends ReferenceStateLeaves> = AssistantTurnStateByProtocol<States>[Protocol];

export type ReplayContent = string | IRJSONObject;
