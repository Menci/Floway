import type { ReferenceStateLeaves } from './types.ts';
import type { AnthropicMessagesInputAssistantTurnState, AnthropicMessagesReferenceableInputAssistantTurn } from '../../protocols/anthropic-messages/as-target/assistant-turn.ts';
import type { GeminiGenerateContentInputAssistantTurnState, GeminiGenerateContentReferenceableInputAssistantTurn } from '../../protocols/gemini-generate-content/as-target/assistant-turn.ts';
import type { OpenAIChatCompletionsInputAssistantTurnState, OpenAIChatCompletionsReferenceableInputAssistantTurn } from '../../protocols/openai-chat-completions/as-target/assistant-turn.ts';
import type { OpenAIResponsesInputAssistantTurnState, OpenAIResponsesReferenceableInputAssistantTurn } from '../../protocols/openai-responses/as-target/assistant-turn.ts';

interface ReferenceableInputAssistantTurnByProtocol<Reference> {
  openaiChatCompletions: OpenAIChatCompletionsReferenceableInputAssistantTurn<Reference>;
  openaiResponses: OpenAIResponsesReferenceableInputAssistantTurn<Reference>;
  anthropicMessages: AnthropicMessagesReferenceableInputAssistantTurn<Reference>;
  geminiGenerateContent: GeminiGenerateContentReferenceableInputAssistantTurn<Reference>;
}

interface InputAssistantTurnStateByProtocol<States extends ReferenceStateLeaves> {
  openaiChatCompletions: OpenAIChatCompletionsInputAssistantTurnState<States>;
  openaiResponses: OpenAIResponsesInputAssistantTurnState<States>;
  anthropicMessages: AnthropicMessagesInputAssistantTurnState<States>;
  geminiGenerateContent: GeminiGenerateContentInputAssistantTurnState<States>;
}

export type ReferenceableInputAssistantTurnFor<Protocol extends keyof ReferenceableInputAssistantTurnByProtocol<Reference>, Reference> = ReferenceableInputAssistantTurnByProtocol<Reference>[Protocol];
export type InputAssistantTurnStateFor<Protocol extends keyof InputAssistantTurnStateByProtocol<States>, States extends ReferenceStateLeaves> = InputAssistantTurnStateByProtocol<States>[Protocol];
