import { geminiGenerateContentBodyStages } from './body-stages.ts';
import { geminiGenerateContentEgress } from './egress.ts';
import { routeGeminiGenerateContent } from './route.ts';
import type { GatewayServices } from '../../../pipeline/services.ts';
import { anthropicMessagesBody } from '../../anthropic-messages/pipeline/body.ts';
import { openaiChatCompletionsBody } from '../../openai-chat-completions/pipeline/body.ts';
import { openaiResponsesBody } from '../../openai-responses/pipeline/body.ts';
import { chatBodyRequest, chatBodyResponse, compose, type BodyRequest, type BodyResponse } from '../../pipeline/facts.ts';
import type { Pipeline } from '@floway-dev/pipeline';

export const geminiGenerateContentBody: Pipeline<BodyRequest<'geminiGenerateContent'>, BodyResponse<'geminiGenerateContent'>, GatewayServices> =
  compose('geminiGenerateContent.body', {
    entry: [...chatBodyRequest, 'geminiGenerateContent'],
    exit: [...chatBodyResponse, 'geminiGenerateContent'],
    stages: [...geminiGenerateContentBodyStages],
    ending: routeGeminiGenerateContent,
    targets: {
      native: geminiGenerateContentEgress,
      openaiChatCompletions: () => openaiChatCompletionsBody,
      anthropicMessages: () => anthropicMessagesBody,
      openaiResponses: () => openaiResponsesBody,
    },
  });
