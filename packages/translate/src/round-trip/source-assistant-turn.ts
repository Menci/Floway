import type { AnthropicMessagesSourceAssistantTurn } from '../protocols/anthropic-messages/as-source/round-trip.ts';
import type { GeminiGenerateContentSourceAssistantTurn } from '../protocols/gemini-generate-content/as-source/round-trip.ts';
import type { OpenAIChatCompletionsSourceAssistantTurn } from '../protocols/openai-chat-completions/as-source/round-trip.ts';
import type { OpenAIResponsesSourceAssistantTurn } from '../protocols/openai-responses/as-source/round-trip.ts';

/**
 * The structure a protocol states an assistant turn in, on the way in.
 *
 * This is not the shape a sidecar restores a turn into — that is
 * `InputAssistantTurnFor`, and it belongs to the target. This is what the source
 * wrote, which is the only thing its sidecar can be computed over.
 */
interface SourceAssistantTurnByProtocol {
  openaiChatCompletions: OpenAIChatCompletionsSourceAssistantTurn;
  openaiResponses: OpenAIResponsesSourceAssistantTurn;
  anthropicMessages: AnthropicMessagesSourceAssistantTurn;
  geminiGenerateContent: GeminiGenerateContentSourceAssistantTurn;
}

export type SourceAssistantTurnFor<Protocol extends keyof SourceAssistantTurnByProtocol> =
  SourceAssistantTurnByProtocol[Protocol];
