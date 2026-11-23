import { responsesInputErrorBody } from './errors.ts';
import { agentMessageShim } from './stages/agent-message-shim.ts';
import { answerWebSocketWarmup } from './stages/answer-websocket-warmup.ts';
import { collaborationShim } from './stages/collaboration-shim.ts';
import { compactShim } from './stages/compact-shim.ts';
import { disableReasoningOnForcedToolChoice } from './stages/disable-reasoning-on-forced-tool-choice.ts';
import { forceStoreFalse } from './stages/force-store-false.ts';
import { normalizeEmptyToolsToolChoice } from './stages/normalize-empty-tools-tool-choice.ts';
import { prepare } from './stages/prepare.ts';
import { serverToolShim } from './stages/server-tool-shim.ts';
import { standaloneToolOutputShim } from './stages/standalone-tool-output-shim.ts';
import { stripPromptCacheKey } from './stages/strip-prompt-cache-key.ts';
import { vendorDeepSeekNormalize } from './stages/vendor-deepseek-normalize.ts';
import { vendorQwenNormalize } from './stages/vendor-qwen-normalize.ts';
import type { GatewayServices } from '../../pipeline/services.ts';
import { type ChatBodyInput, type ChatBodyOutput, type ChatBodyTargets, createOpenAIResponsesRouteBody } from '../shared/route-body.ts';
import { openaiResponsesTarget, pickTarget } from '../shared/target-picker.ts';
import { compose } from '@floway-dev/pipeline';

type Api = 'openaiResponses';
export const createOpenAIResponsesBody = (targets: ChatBodyTargets<Api>) =>
  compose<ChatBodyInput<Api>, ChatBodyOutput<Api>, GatewayServices, ChatBodyTargets<Api>>('openai-responses.body', {
    stages: [
      pickTarget(openaiResponsesTarget), prepare, answerWebSocketWarmup, agentMessageShim, standaloneToolOutputShim,
      compactShim, collaborationShim, serverToolShim, disableReasoningOnForcedToolChoice, normalizeEmptyToolsToolChoice,
      stripPromptCacheKey, forceStoreFalse, vendorDeepSeekNormalize, vendorQwenNormalize,
    ],
    targets,
    ending: createOpenAIResponsesRouteBody(responsesInputErrorBody),
  });
