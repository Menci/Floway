import { openaiResponsesBodyAfterHostedTools, openaiResponsesBodyBeforeHostedTools } from './body-stages.ts';
import { openaiResponsesEgress } from './egress.ts';
import { openAIResponsesHostedTools } from './hosted-tools.ts';
import { routeOpenAIResponses } from './route.ts';
import type { GatewayServices } from '../../../pipeline/services.ts';
import { anthropicMessagesBody } from '../../anthropic-messages/pipeline/body.ts';
import { openaiChatCompletionsBody } from '../../openai-chat-completions/pipeline/body.ts';
import { chatBodyRequest, chatBodyResponse, compose, type BodyRequest, type BodyResponse } from '../../pipeline/facts.ts';
import type { Pipeline } from '@floway-dev/pipeline';

export const openaiResponsesBody: Pipeline<BodyRequest<'openaiResponses'>, BodyResponse<'openaiResponses'>, GatewayServices> =
  compose('openaiResponses.body', {
    entry: [...chatBodyRequest, 'openaiResponses'],
    exit: [...chatBodyResponse, 'openaiResponses'],
    stages: [...openaiResponsesBodyBeforeHostedTools, openAIResponsesHostedTools, ...openaiResponsesBodyAfterHostedTools],
    ending: routeOpenAIResponses,
    targets: {
      native: openaiResponsesEgress,
      anthropicMessages: () => anthropicMessagesBody,
      openaiChatCompletions: () => openaiChatCompletionsBody,
    },
  });
