import { anthropicMessagesBodyStages } from './body-stages.ts';
import { answerClaudeCodeProbe } from './claude-code-probe.ts';
import { anthropicMessagesEgress } from './egress.ts';
import { anthropicMessagesHostedTools } from './hosted-tools.ts';
import { routeAnthropicMessages } from './route.ts';
import type { GatewayServices } from '../../../pipeline/services.ts';
import { openaiChatCompletionsBody } from '../../openai-chat-completions/pipeline/body.ts';
import { openaiResponsesBody } from '../../openai-responses/pipeline/body.ts';
import { chatBodyRequest, chatBodyResponse, compose, type BodyRequest, type BodyResponse } from '../../pipeline/facts.ts';
import type { Pipeline } from '@floway-dev/pipeline';

export const anthropicMessagesBody: Pipeline<BodyRequest<'anthropicMessages'>, BodyResponse<'anthropicMessages'>, GatewayServices> =
  compose('anthropicMessages.body', {
    entry: [...chatBodyRequest, 'anthropicMessages'],
    exit: [...chatBodyResponse, 'anthropicMessages'],
    stages: [answerClaudeCodeProbe, anthropicMessagesHostedTools, ...anthropicMessagesBodyStages],
    ending: routeAnthropicMessages,
    targets: {
      native: anthropicMessagesEgress,
      openaiResponses: () => openaiResponsesBody,
      openaiChatCompletions: () => openaiChatCompletionsBody,
    },
  });
