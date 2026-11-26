import { analyzeOpenAIResponsesAffinity } from './affinity/ingress.ts';
import { openAIResponsesAffinityOutput } from './affinity/output-stage.ts';
import { lowerOpenAIResponsesAgentMessage } from './agent-message.ts';
import { applyOpenAIResponsesAliasRules } from './alias-rules.ts';
import { normalizeOpenAIResponsesAssistantInput } from './assistant-input.ts';
import { normalizeOpenAIResponsesCachedTokens } from './cached-token-usage.ts';
import { openAIResponsesClientOutput } from './client-output.ts';
import { applyOpenAIResponsesCollaboration } from './collaboration.ts';
import { collectOpenAIResponses, openAIResponsesStreamFailure } from './collect.ts';
import { compactOpenAIResponsesHistory } from './compaction.ts';
import { normalizeOpenAIResponsesEmptyToolsToolChoice } from './empty-tools-tool-choice.ts';
import { encodeOpenAIResponses } from './encode.ts';
import { openAIResponsesLocalError } from './errors.ts';
import { nullOpenAIResponsesUnresolvedFunctionCallNamespace } from './function-call-namespace.ts';
import { openAIResponsesHostedTools } from './hosted-tools.ts';
import { parseOpenAIResponses, parseOpenAIResponsesWebSocket } from './parse.ts';
import type { OpenAIResponsesDelivery } from './pipeline-facts.ts';
import { stripOpenAIResponsesPromptCacheKey } from './prompt-cache-key.ts';
import { disableOpenAIResponsesReasoningOnForcedToolChoice } from './reasoning-tool-choice.ts';
import { applyOpenAIResponsesRoleCompatibility } from './role-compatibility.ts';
import { serializeOpenAIResponsesClientStream } from './serialize-stream-items.ts';
import { lowerOpenAIResponsesStandaloneToolOutput } from './standalone-tool-output.ts';
import { forceOpenAIResponsesStoreFalse } from './store-false.ts';
import { openAIResponsesUsage } from './usage.ts';
import { answerOpenAIResponsesWebSocketWarmup } from './warmup.ts';
import { appendFailedUpstreams } from '../../shared/failed-upstreams.ts';
import type { ChatProtocolStages } from '../shared/pipeline.ts';

export const openAIResponsesChat: ChatProtocolStages<'openaiResponses', OpenAIResponsesDelivery> = {
  parse: parseOpenAIResponses,
  parseWebSocket: parseOpenAIResponsesWebSocket,
  encode: encodeOpenAIResponses,
  ingress: [openAIResponsesClientOutput],
  clientEgress: [openAIResponsesAffinityOutput, serializeOpenAIResponsesClientStream],
  body: [
    answerOpenAIResponsesWebSocketWarmup,
    normalizeOpenAIResponsesAssistantInput,
    lowerOpenAIResponsesAgentMessage,
    lowerOpenAIResponsesStandaloneToolOutput,
    compactOpenAIResponsesHistory,
    applyOpenAIResponsesCollaboration,
    openAIResponsesHostedTools,
    nullOpenAIResponsesUnresolvedFunctionCallNamespace,
    disableOpenAIResponsesReasoningOnForcedToolChoice,
    normalizeOpenAIResponsesEmptyToolsToolChoice,
  ],
  egress: [
    applyOpenAIResponsesRoleCompatibility,
    stripOpenAIResponsesPromptCacheKey,
    forceOpenAIResponsesStoreFalse,
    normalizeOpenAIResponsesCachedTokens,
    applyOpenAIResponsesAliasRules,
  ],
  usage: openAIResponsesUsage,
  collect: collectOpenAIResponses,
  streamError: openAIResponsesStreamFailure,
  model: payload => payload.model,
  unavailable: ({ exists, model, failedUpstreams }) => openAIResponsesLocalError(exists ? 400 : 404, appendFailedUpstreams(
    exists ? `Model ${model} does not support the /responses endpoint.` : `Model ${model} is not available on any configured upstream.`,
    failedUpstreams,
  )),
  affinityUnavailable: message => openAIResponsesLocalError(400, message, { param: 'input', code: 'responses_item_routing_unavailable' }),
  invalidTranslation: error => openAIResponsesLocalError(400, error.message, { param: error.param ?? 'input', code: error.code ?? null }),
  analyzeAffinity: analyzeOpenAIResponsesAffinity,
};
