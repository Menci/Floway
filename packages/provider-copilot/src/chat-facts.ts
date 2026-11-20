import type { CopilotSession } from './pipeline-facts.ts';
import type { HttpHeaders, HttpRequestFacts } from '@floway-dev/http/pipeline';
import type { AnthropicMessagesPayload } from '@floway-dev/protocols/anthropic-messages';
import type { OpenAIChatCompletionsPayloadEx } from '@floway-dev/protocols/openai-chat-completions';
import type { CanonicalOpenAIResponsesPayload } from '@floway-dev/protocols/openai-responses';
import type { ProviderModelFacts } from '@floway-dev/provider';

export interface ChatFacts<P> {
  'request.provider.model': ProviderModelFacts;
  'request.provider.payload': P;
  'request.provider.modelKey': string;
  'request.http.callId': number;
  'request.http.headers': HttpHeaders;
}
export type ChatCompletionsFacts = ChatFacts<OpenAIChatCompletionsPayloadEx>;
export type ResponsesFacts = ChatFacts<CanonicalOpenAIResponsesPayload> & { 'request.provider.responsesAction': 'generate' | 'compact' };
export type MessagesFacts = ChatFacts<AnthropicMessagesPayload> & { 'request.provider.anthropicBeta': readonly string[] };
export type CopilotChatFacts = ChatFacts<OpenAIChatCompletionsPayloadEx | CanonicalOpenAIResponsesPayload | AnthropicMessagesPayload> & { 'request.provider.anthropicBeta'?: readonly string[]; 'request.provider.responsesAction'?: 'generate' | 'compact' };
export type AuthenticatedChatFacts = CopilotChatFacts & { 'request.copilot.session': CopilotSession };
export interface CopilotChatHttpFacts extends HttpRequestFacts {
  'request.provider.modelKey': string;
}
