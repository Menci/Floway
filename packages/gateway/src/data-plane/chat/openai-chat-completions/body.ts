import { openaiChatCompletionsInputError } from './errors.ts';
import { disableReasoningOnForcedToolChoice } from './stages/disable-reasoning-on-forced-tool-choice.ts';
import { includeUsageStreamOptions } from './stages/include-usage-stream-options.ts';
import { normalizeEmptyToolsToolChoice } from './stages/normalize-empty-tools-tool-choice.ts';
import { normalizeUsage } from './stages/normalize-usage.ts';
import { stripPromptCacheKey } from './stages/strip-prompt-cache-key.ts';
import { normalizeDeepSeekRequest } from './stages/vendor-deepseek-request.ts';
import { normalizeQwenRequest } from './stages/vendor-qwen-request.ts';
import type { GatewayServices } from '../../pipeline/services.ts';
import { type ChatBodyInput, type ChatBodyOutput, type ChatBodyTargets, createOpenAIChatCompletionsRouteBody } from '../shared/route-body.ts';
import { openaiChatCompletionsTarget, pickTarget } from '../shared/target-picker.ts';
import { compose } from '@floway-dev/pipeline';

type Api = 'openaiChatCompletions';
type Space = ChatBodyInput<Api> & ChatBodyOutput<Api>;

export const createOpenAIChatCompletionsBody = ({ egress, messages, responses }: ChatBodyTargets<Api>) =>
  compose<Space, GatewayServices>()('openaiChatCompletions.body', {
    entry: [
      'request.http', 'request.auth.apiKeyId', 'request.auth.user', 'request.route.upstreamIds', 'request.route.randomizeUpstreams',
      'request.route.runtimeLocation', 'route.candidate', 'request.openaiChatCompletions',
    ],
    exit: ['response.http', 'response.openaiChatCompletions'],
    stages: [
      pickTarget(openaiChatCompletionsTarget),
      includeUsageStreamOptions, normalizeUsage, disableReasoningOnForcedToolChoice, normalizeEmptyToolsToolChoice,
      stripPromptCacheKey, normalizeDeepSeekRequest, normalizeQwenRequest,
    ],
    ending: createOpenAIChatCompletionsRouteBody(openaiChatCompletionsInputError),
    targets: { egress, messages, responses },
  });
