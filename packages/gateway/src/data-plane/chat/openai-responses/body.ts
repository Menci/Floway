import { responsesInputErrorBody } from './errors.ts';
import { agentMessageShim } from './stages/agent-message-shim.ts';
import { answerWebSocketWarmup } from './stages/answer-websocket-warmup.ts';
import { collaborationShim } from './stages/collaboration-shim.ts';
import { compactShim } from './stages/compact-shim.ts';
import { disableReasoningOnForcedToolChoice } from './stages/disable-reasoning-on-forced-tool-choice.ts';
import { forceStoreFalse } from './stages/force-store-false.ts';
import { normalizeEmptyToolsToolChoice } from './stages/normalize-empty-tools-tool-choice.ts';
import { nullUnresolvedFunctionCallNamespace } from './stages/null-unresolved-function-call-namespace.ts';
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
type Space = ChatBodyInput<Api> & ChatBodyOutput<Api> & {
  readonly 'request.ws.responseId'?: string;
};
const entry = ['request.http', 'request.auth.apiKeyId', 'request.auth.user', 'request.route.upstreamIds',
  'request.route.randomizeUpstreams', 'request.route.runtimeLocation', 'request.action', 'request.openaiResponses', 'route.candidate'] as const;
const optionalEntry = ['request.ws.responseId'] as const;
const exit = ['response.http', 'response.openaiResponses'] as const;

const selectTarget = pickTarget(openaiResponsesTarget);
const requestStages = [
  agentMessageShim, standaloneToolOutputShim, compactShim, collaborationShim, serverToolShim,
  nullUnresolvedFunctionCallNamespace, disableReasoningOnForcedToolChoice, normalizeEmptyToolsToolChoice,
  stripPromptCacheKey, forceStoreFalse, vendorDeepSeekNormalize, vendorQwenNormalize,
];

export const createOpenAIResponsesBody = (targets: ChatBodyTargets<Api>) =>
  compose<Space, GatewayServices>()('openai-responses.body', {
    entry, optionalEntry, exit,
    stages: [selectTarget, prepare, answerWebSocketWarmup, ...requestStages],
    targets,
    ending: createOpenAIResponsesRouteBody(responsesInputErrorBody),
  });
