import { createAnthropicMessagesBody, createAnthropicMessagesCountBody } from './anthropic-messages/body.ts';
import { anthropicMessagesCountEgress, anthropicMessagesEgress } from './anthropic-messages/egress.ts';
import { createAnthropicMessagesCountIngress, createAnthropicMessagesIngress } from './anthropic-messages/ingress.ts';
import { createGeminiGenerateContentBody, createGeminiGenerateContentCountBody } from './gemini-generate-content/body.ts';
import { geminiGenerateContentCountEgress, geminiGenerateContentEgress } from './gemini-generate-content/egress.ts';
import { createGeminiGenerateContentCountIngress, createGeminiGenerateContentIngress } from './gemini-generate-content/ingress.ts';
import { createGeminiGenerateContentRoute } from './gemini-generate-content/route.ts';
import { createOpenAIChatCompletionsBody } from './openai-chat-completions/body.ts';
import { openaiChatCompletionsEgress } from './openai-chat-completions/egress.ts';
import { createOpenAIChatCompletionsIngress } from './openai-chat-completions/ingress.ts';
import { createOpenAIResponsesBody } from './openai-responses/body.ts';
import { openaiResponsesEgress } from './openai-responses/egress.ts';
import { createOpenAIResponsesCompactIngress, createOpenAIResponsesIngress } from './openai-responses/ingress.ts';
import { createOpenAIResponsesWsIngress } from './openai-responses/websocket-ingress.ts';
import type { ChatBodyInput, ChatBodyOutput } from './shared/route-body.ts';
import type { GatewayServices } from '../pipeline/services.ts';
import { link, type Pipeline } from '@floway-dev/pipeline';
import type { ChatTargetApi } from '@floway-dev/provider';

type Body<Api extends ChatTargetApi> = Pipeline<ChatBodyInput<Api>, ChatBodyOutput<Api>, GatewayServices>;

const chatCompletionsBody: Body<'openaiChatCompletions'> = createOpenAIChatCompletionsBody({
  egress: openaiChatCompletionsEgress,
  messages: () => messagesBody,
  responses: () => responsesBody,
});
const responsesBody: Body<'openaiResponses'> = createOpenAIResponsesBody({
  egress: openaiResponsesEgress,
  messages: () => messagesBody,
  chatCompletions: () => chatCompletionsBody,
});
const messagesBody: Body<'anthropicMessages'> = createAnthropicMessagesBody({
  egress: anthropicMessagesEgress,
  responses: () => responsesBody,
  chatCompletions: () => chatCompletionsBody,
});
const geminiBody = createGeminiGenerateContentBody({
  egress: geminiGenerateContentEgress,
  messages: () => messagesBody,
  responses: () => responsesBody,
  chatCompletions: () => chatCompletionsBody,
});
const messagesCountBody = createAnthropicMessagesCountBody({ egress: anthropicMessagesCountEgress });
const geminiCountBody = createGeminiGenerateContentCountBody({
  egress: geminiGenerateContentCountEgress,
  messagesCount: () => messagesCountBody,
});

export const openaiChatCompletionsIngress = createOpenAIChatCompletionsIngress(chatCompletionsBody);
export const openaiResponsesIngress = createOpenAIResponsesIngress(responsesBody);
export const openaiResponsesCompactIngress = createOpenAIResponsesCompactIngress(responsesBody);
export const openaiResponsesWsIngress = createOpenAIResponsesWsIngress(responsesBody);
export const anthropicMessagesIngress = createAnthropicMessagesIngress(messagesBody);
export const anthropicMessagesCountIngress = createAnthropicMessagesCountIngress(messagesCountBody);
const geminiGenerateContentIngress = createGeminiGenerateContentIngress(geminiBody);
const geminiGenerateContentCountIngress = createGeminiGenerateContentCountIngress(geminiCountBody);
export const geminiGenerateContentRoute = createGeminiGenerateContentRoute({
  generate: geminiGenerateContentIngress, count: geminiGenerateContentCountIngress,
});

link([
  openaiChatCompletionsIngress,
  openaiResponsesIngress,
  openaiResponsesCompactIngress,
  openaiResponsesWsIngress,
  anthropicMessagesIngress,
  anthropicMessagesCountIngress,
  geminiGenerateContentRoute,
]);
