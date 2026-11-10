import type { ReferenceStateLeaves } from './reference-type.ts';
import type { AnthropicMessagesAssistantState, AnthropicMessagesReferenceableAssistantTurn } from '../../protocols/anthropic-messages/as-target/assistant-turn.ts';
import type { GeminiGenerateContentAssistantState, GeminiGenerateContentReferenceableAssistantTurn } from '../../protocols/gemini-generate-content/as-target/assistant-turn.ts';
import type { OpenAIChatCompletionsAssistantState, OpenAIChatCompletionsReferenceableAssistantTurn } from '../../protocols/openai-chat-completions/as-target/assistant-turn.ts';
import type { OpenAIResponsesAssistantState, OpenAIResponsesReferenceableAssistantTurn } from '../../protocols/openai-responses/as-target/assistant-turn.ts';

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

export type ReferenceableInputAssistantTurnFor<Protocol extends keyof ReferenceableAssistantTurnByProtocol<Reference>, Reference> = ReferenceableAssistantTurnByProtocol<Reference>[Protocol];
export type InputAssistantTurnStateFor<Protocol extends keyof AssistantTurnStateByProtocol<States>, States extends ReferenceStateLeaves> = AssistantTurnStateByProtocol<States>[Protocol];
