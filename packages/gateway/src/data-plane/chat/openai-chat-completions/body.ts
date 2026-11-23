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

export const createOpenAIChatCompletionsBody = (targets: ChatBodyTargets<Api>) =>
  compose<ChatBodyInput<Api>, ChatBodyOutput<Api>, GatewayServices, ChatBodyTargets<Api>>('openaiChatCompletions.body', {
    stages: [
      pickTarget(openaiChatCompletionsTarget),
      includeUsageStreamOptions, normalizeUsage, disableReasoningOnForcedToolChoice, normalizeEmptyToolsToolChoice,
      stripPromptCacheKey, normalizeDeepSeekRequest, normalizeQwenRequest,
    ],
    ending: createOpenAIChatCompletionsRouteBody(openaiChatCompletionsInputError),
    targets,
  });
