import { applyRoleCompatibility } from './apply-role-compatibility.ts';
import { disableReasoningOnForcedToolChoice } from './disable-reasoning-on-forced-tool-choice.ts';
import { openAIChatCompletionsEgress } from './egress.ts';
import { includeUsageStreamOptions } from './include-usage-stream-options.ts';
import { normalizeEmptyToolsToolChoice } from './normalize-empty-tools-tool-choice.ts';
import { openAIChatCompletionsInputError } from './parse-request.ts';
import { stripPromptCacheKey } from './strip-prompt-cache-key.ts';
import { gatewayFactSpace, type GatewayPipelineFacts } from '../../../pipeline/facts.ts';
import type { GatewayServices } from '../../../pipeline/services.ts';
import { anthropicMessagesBody } from '../../anthropic-messages/pipeline/body.ts';
import { openAIResponsesBody } from '../../openai-responses/pipeline/body.ts';
import { chatBodyEntry, chatBodyExit, chatBodyTargets } from '../../pipeline/topology.ts';
import { translateChat } from '../../pipeline/translate.ts';
import type { Pipeline } from '@floway-dev/pipeline';
import { routeOpenAIChatCompletionsViaAnthropicMessages, routeOpenAIChatCompletionsViaOpenAIResponses } from '@floway-dev/translate';

const protocol = 'openaiChatCompletions';
const { compose } = gatewayFactSpace<GatewayServices>();
const entry = chatBodyEntry(protocol);
const exit = chatBodyExit(protocol);

const bodyTargets = chatBodyTargets(protocol, openAIChatCompletionsEgress, [
  ['anthropicMessages', () => translateChat(protocol, 'anthropicMessages', routeOpenAIChatCompletionsViaAnthropicMessages, () => anthropicMessagesBody, openAIChatCompletionsInputError)],
  ['openaiResponses', () => translateChat(protocol, 'openaiResponses', routeOpenAIChatCompletionsViaOpenAIResponses, () => openAIResponsesBody, openAIChatCompletionsInputError)],
]);

export const servesOpenAIChatCompletions = bodyTargets.serves;

export const openAIChatCompletionsBody: Pipeline<Pick<GatewayPipelineFacts, typeof entry[number]>, Pick<GatewayPipelineFacts, typeof exit[number]>, GatewayServices> = compose('openaiChatCompletions.body', {
  entry,
  exit,
  stages: [
    includeUsageStreamOptions,
    disableReasoningOnForcedToolChoice,
    normalizeEmptyToolsToolChoice,
    applyRoleCompatibility,
    stripPromptCacheKey,
  ],
  ending: bodyTargets.ending,
  targets: bodyTargets.targets,
});
