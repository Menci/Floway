import { lowerOpenAIResponsesAgentMessage } from './agent-message.ts';
import { applyOpenAIResponsesRoleCompatibility } from './apply-role-compatibility.ts';
import { projectOpenAIResponsesCollaboration } from './collaboration.ts';
import { compactOpenAIResponses } from './compact.ts';
import { disableOpenAIResponsesReasoningOnForcedToolChoice } from './disable-reasoning-on-forced-tool-choice.ts';
import { openAIResponsesCompactEgress, openAIResponsesEgress } from './egress.ts';
import { openAIResponsesInputErrorBody } from './error.ts';
import { openAIResponsesBodyEntry, openAIResponsesExit, openAIResponsesFactSpace, type OpenAIResponsesAnswer, type OpenAIResponsesBodyInput } from './facts.ts';
import { forceOpenAIResponsesStoreFalse } from './force-store-false.ts';
import { normalizeOpenAIResponsesAssistantInput } from './normalize-assistant-input.ts';
import { normalizeOpenAIResponsesEmptyToolsToolChoice } from './normalize-empty-tools-tool-choice.ts';
import { nullOpenAIResponsesUnresolvedFunctionCallNamespace } from './null-unresolved-function-call-namespace.ts';
import { lowerOpenAIResponsesStandaloneToolOutput } from './standalone-tool-output.ts';
import { stripOpenAIResponsesPromptCacheKey } from './strip-prompt-cache-key.ts';
import { openAIResponsesTargetFor } from './target.ts';
import { answerOpenAIResponsesWebSocketWarmup } from './websocket-warmup.ts';
import type { GatewayServices } from '../../../pipeline/services.ts';
import { anthropicMessagesBody } from '../../anthropic-messages/pipeline/body.ts';
import { openAIChatCompletionsBody } from '../../openai-chat-completions/pipeline/body.ts';
import { translateChat } from '../../pipeline/translate.ts';
import type { Pipeline } from '@floway-dev/pipeline';
import { routeOpenAIResponsesViaAnthropicMessages, routeOpenAIResponsesViaOpenAIChatCompletions } from '@floway-dev/translate';

const { compose, defineStage } = openAIResponsesFactSpace<GatewayServices>();

const destination = {
  request: { needs: openAIResponsesBodyEntry, provides: [], consumes: ['request.openaiResponsesAction'] },
  response: { needs: openAIResponsesExit, provides: [], consumes: [] },
} as const;

const routeOpenAIResponsesBody = defineStage({
  name: 'openaiResponses.route-body',
  request: { needs: openAIResponsesBodyEntry },
  into: {
    openaiResponses: destination,
    openaiResponsesCompact: destination,
    anthropicMessages: destination,
    openaiChatCompletions: destination,
  },
  async execute({ 'request.openaiResponsesAction': action, ...facts }, scope) {
    if (action === 'compact') return await scope.into.openaiResponsesCompact(facts);
    const candidate = facts['serve.candidate'];
    const target = openAIResponsesTargetFor(candidate);
    if (target === undefined) throw new TypeError(`The OpenAI Responses body cannot serve ${candidate.upstream.id}/${candidate.model.id}`);
    return await scope.into[target](facts);
  },
});

export const openAIResponsesBody: Pipeline<OpenAIResponsesBodyInput, OpenAIResponsesAnswer, GatewayServices> = compose('openaiResponses.body', {
  entry: openAIResponsesBodyEntry,
  exit: openAIResponsesExit,
  stages: [
    normalizeOpenAIResponsesAssistantInput,
    answerOpenAIResponsesWebSocketWarmup,
    lowerOpenAIResponsesAgentMessage,
    lowerOpenAIResponsesStandaloneToolOutput,
    compactOpenAIResponses,
    projectOpenAIResponsesCollaboration,
    nullOpenAIResponsesUnresolvedFunctionCallNamespace,
    disableOpenAIResponsesReasoningOnForcedToolChoice,
    normalizeOpenAIResponsesEmptyToolsToolChoice,
    applyOpenAIResponsesRoleCompatibility,
    stripOpenAIResponsesPromptCacheKey,
    forceOpenAIResponsesStoreFalse,
  ],
  ending: routeOpenAIResponsesBody,
  targets: {
    openaiResponses: openAIResponsesEgress,
    openaiResponsesCompact: openAIResponsesCompactEgress,
    anthropicMessages: () => translateChat(
      'openaiResponses', 'anthropicMessages', routeOpenAIResponsesViaAnthropicMessages, () => anthropicMessagesBody, openAIResponsesInputErrorBody,
    ),
    openaiChatCompletions: () => translateChat(
      'openaiResponses', 'openaiChatCompletions', routeOpenAIResponsesViaOpenAIChatCompletions, () => openAIChatCompletionsBody, openAIResponsesInputErrorBody,
    ),
  },
});
