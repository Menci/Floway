import type { AnthropicMessagesSourceAssistantTurn } from '../protocols/anthropic-messages/as-source/round-trip.ts';
import type { GeminiGenerateContentSourceAssistantTurn } from '../protocols/gemini-generate-content/as-source/round-trip.ts';
import type { OpenAIChatCompletionsSourceAssistantTurn } from '../protocols/openai-chat-completions/as-source/round-trip.ts';
import type { OpenAIResponsesSourceAssistantTurn } from '../protocols/openai-responses/as-source/round-trip.ts';

/**
 * Source sidecars authenticate the source's native assistant structure.
 * Target replay uses InputAssistantTurnFor.
 */
interface SourceAssistantTurnByProtocol {
  openaiChatCompletions: OpenAIChatCompletionsSourceAssistantTurn;
  openaiResponses: OpenAIResponsesSourceAssistantTurn;
  anthropicMessages: AnthropicMessagesSourceAssistantTurn;
  geminiGenerateContent: GeminiGenerateContentSourceAssistantTurn;
}

export type SourceAssistantTurnFor<Protocol extends keyof SourceAssistantTurnByProtocol> =
  SourceAssistantTurnByProtocol[Protocol];
