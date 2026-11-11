import type { AnthropicMessagesInputAssistantTurn } from '../protocols/anthropic-messages/as-target/assistant-turn.ts';
import type { GeminiGenerateContentInputAssistantTurn } from '../protocols/gemini-generate-content/as-target/assistant-turn.ts';
import type { OpenAIChatCompletionsInputAssistantTurn } from '../protocols/openai-chat-completions/as-target/assistant-turn.ts';
import type { OpenAIResponsesInputAssistantTurn } from '../protocols/openai-responses/as-target/assistant-turn.ts';

export interface InputAssistantTurnByProtocol {
  openaiChatCompletions: OpenAIChatCompletionsInputAssistantTurn;
  openaiResponses: OpenAIResponsesInputAssistantTurn;
  anthropicMessages: AnthropicMessagesInputAssistantTurn;
  geminiGenerateContent: GeminiGenerateContentInputAssistantTurn;
}

export type InputAssistantTurnFor<Protocol extends keyof InputAssistantTurnByProtocol> = InputAssistantTurnByProtocol[Protocol];

/** Every protocol a round trip can name on either side. */
export type AssistantTurnProtocol = keyof InputAssistantTurnByProtocol;
