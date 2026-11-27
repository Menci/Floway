import { openaiChatCompletionsBodyStages } from './body-stages.ts';
import { openaiChatCompletionsEgress } from './egress.ts';
import { routeOpenAIChatCompletions } from './route.ts';
import type { GatewayServices } from '../../../pipeline/services.ts';
import { anthropicMessagesBody } from '../../anthropic-messages/pipeline/body.ts';
import { openaiResponsesBody } from '../../openai-responses/pipeline/body.ts';
import { chatBodyRequest, chatBodyResponse, compose, type BodyRequest, type BodyResponse } from '../../pipeline/facts.ts';
import type { Pipeline } from '@floway-dev/pipeline';

export const openaiChatCompletionsBody: Pipeline<BodyRequest<'openaiChatCompletions'>, BodyResponse<'openaiChatCompletions'>, GatewayServices> =
  compose('openaiChatCompletions.body', {
    entry: [...chatBodyRequest, 'openaiChatCompletions'],
    exit: [...chatBodyResponse, 'openaiChatCompletions'],
    stages: [...openaiChatCompletionsBodyStages],
    ending: routeOpenAIChatCompletions,
    targets: {
      native: openaiChatCompletionsEgress,
      anthropicMessages: () => anthropicMessagesBody,
      openaiResponses: () => openaiResponsesBody,
    },
  });
