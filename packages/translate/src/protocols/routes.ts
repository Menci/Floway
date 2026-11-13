import { anthropicMessagesSourceProtocol } from './anthropic-messages/as-source.ts';
import { anthropicMessagesTargetProtocol } from './anthropic-messages/as-target.ts';
import { composeTranslation } from '../composition/index.ts';
import { geminiGenerateContentSourceProtocol } from './gemini-generate-content/as-source.ts';
import { openaiChatCompletionsSourceProtocol } from './openai-chat-completions/as-source.ts';
import { openaiChatCompletionsTargetProtocol } from './openai-chat-completions/as-target.ts';
import { openaiResponsesSourceProtocol } from './openai-responses/as-source.ts';
import { openaiResponsesTargetProtocol } from './openai-responses/as-target.ts';

export const routeAnthropicMessagesViaOpenAIChatCompletions =
  composeTranslation(anthropicMessagesSourceProtocol, openaiChatCompletionsTargetProtocol);

export const routeAnthropicMessagesViaOpenAIResponses =
  composeTranslation(anthropicMessagesSourceProtocol, openaiResponsesTargetProtocol);

export const routeGeminiGenerateContentViaAnthropicMessages =
  composeTranslation(geminiGenerateContentSourceProtocol, anthropicMessagesTargetProtocol);

export const routeGeminiGenerateContentViaOpenAIChatCompletions =
  composeTranslation(geminiGenerateContentSourceProtocol, openaiChatCompletionsTargetProtocol);

export const routeGeminiGenerateContentViaOpenAIResponses =
  composeTranslation(geminiGenerateContentSourceProtocol, openaiResponsesTargetProtocol);

export const routeOpenAIChatCompletionsViaAnthropicMessages =
  composeTranslation(openaiChatCompletionsSourceProtocol, anthropicMessagesTargetProtocol);

export const routeOpenAIChatCompletionsViaOpenAIResponses =
  composeTranslation(openaiChatCompletionsSourceProtocol, openaiResponsesTargetProtocol);

export const routeOpenAIResponsesViaAnthropicMessages =
  composeTranslation(openaiResponsesSourceProtocol, anthropicMessagesTargetProtocol);

export const routeOpenAIResponsesViaOpenAIChatCompletions =
  composeTranslation(openaiResponsesSourceProtocol, openaiChatCompletionsTargetProtocol);
