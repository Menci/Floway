import { answerClaudeCodeProbe } from './answer-claude-code-probe.ts';
import { applyRoleCompatibility } from './apply-role-compatibility.ts';
import { disableReasoningOnForcedToolChoice } from './disable-reasoning-on-forced-tool-choice.ts';
import { anthropicMessagesEgress } from './egress.ts';
import { normalizeEmptyToolsToolChoice } from './normalize-empty-tools-tool-choice.ts';
import { anthropicMessagesInputError } from './parse-request.ts';
import { stripBillingAttribution } from './strip-billing-attribution.ts';
import { anthropicMessagesWebSearch } from './web-search-shim.ts';
import { gatewayFactSpace, type GatewayPipelineFacts } from '../../../pipeline/facts.ts';
import type { GatewayServices } from '../../../pipeline/services.ts';
import { openAIChatCompletionsBody } from '../../openai-chat-completions/pipeline/body.ts';
import { openAIResponsesBody } from '../../openai-responses/pipeline/body.ts';
import { chatBodyEntry, chatBodyExit, chatBodyTargets } from '../../pipeline/topology.ts';
import { translateChat } from '../../pipeline/translate.ts';
import type { Pipeline } from '@floway-dev/pipeline';
import { routeAnthropicMessagesViaOpenAIChatCompletions, routeAnthropicMessagesViaOpenAIResponses } from '@floway-dev/translate';

const protocol = 'anthropicMessages';
const { compose } = gatewayFactSpace<GatewayServices>();
const entry = chatBodyEntry(protocol);
const exit = chatBodyExit(protocol);

const bodyTargets = chatBodyTargets(protocol, anthropicMessagesEgress, [
  ['openaiResponses', () => translateChat(protocol, 'openaiResponses', routeAnthropicMessagesViaOpenAIResponses, () => openAIResponsesBody, anthropicMessagesInputError)],
  ['openaiChatCompletions', () => translateChat(protocol, 'openaiChatCompletions', routeAnthropicMessagesViaOpenAIChatCompletions, () => openAIChatCompletionsBody, anthropicMessagesInputError)],
]);

export const servesAnthropicMessages = bodyTargets.serves;

export const anthropicMessagesBody: Pipeline<Pick<GatewayPipelineFacts, typeof entry[number]>, Pick<GatewayPipelineFacts, typeof exit[number]>, GatewayServices> = compose('anthropicMessages.body', {
  entry,
  exit,
  stages: [
    answerClaudeCodeProbe,
    anthropicMessagesWebSearch(protocol),
    stripBillingAttribution,
    disableReasoningOnForcedToolChoice,
    normalizeEmptyToolsToolChoice,
    applyRoleCompatibility(protocol),
  ],
  ending: bodyTargets.ending,
  targets: bodyTargets.targets,
});
