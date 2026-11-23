import type { AnthropicMessagesCountEgressOutput } from './egress.ts';
import { anthropicMessagesInputErrorBody } from './errors.ts';
import { answerClaudeCodeProbe } from './stages/answer-claude-code-probe.ts';
import { applyRoleCompatibility } from './stages/apply-role-compatibility.ts';
import { disableReasoningOnForcedToolChoice } from './stages/disable-reasoning-on-forced-tool-choice.ts';
import { normalizeEmptyToolsToolChoice } from './stages/normalize-empty-tools-tool-choice.ts';
import { prepareCount } from './stages/prepare-count.ts';
import { prepareGenerate } from './stages/prepare-generate.ts';
import { prepareWebSearchCount } from './stages/prepare-web-search-count.ts';
import { stripBillingAttribution } from './stages/strip-billing-attribution.ts';
import { webSearchShim } from './stages/web-search-shim.ts';
import type { HttpOutput } from '../../pipeline/edge-http.ts';
import { emptyUsageFacts, type UsageFacts, usageResponseKeys } from '../../pipeline/observe-usage.ts';
import type { GatewayServices } from '../../pipeline/services.ts';
import { type ChatBodyInput, type ChatBodyOutput, type ChatBodyTargets, type ChatEgressInput, createAnthropicMessagesRouteBody } from '../shared/route-body.ts';
import { anthropicMessagesCountTokensTarget, anthropicMessagesGenerateTarget, pickTarget } from '../shared/target-picker.ts';
import { compose, defineEnding, type StaticTarget } from '@floway-dev/pipeline';

type MessagesBodyInput = ChatBodyInput<'anthropicMessages'>;
type MessagesBodyOutput = ChatBodyOutput<'anthropicMessages'>;
type MessagesBodyTargets = ChatBodyTargets<'anthropicMessages'>;

const requestStages = [stripBillingAttribution, disableReasoningOnForcedToolChoice, normalizeEmptyToolsToolChoice, applyRoleCompatibility];

export const createAnthropicMessagesBody = (targets: MessagesBodyTargets) =>
  compose<MessagesBodyInput, MessagesBodyOutput, GatewayServices, MessagesBodyTargets>('anthropicMessages.body', {
    stages: [pickTarget(anthropicMessagesGenerateTarget), prepareGenerate, answerClaudeCodeProbe, webSearchShim, ...requestStages],
    ending: createAnthropicMessagesRouteBody(anthropicMessagesInputErrorBody),
    targets,
  });

export type AnthropicMessagesCountBodyInput = MessagesBodyInput & {
  readonly 'request.anthropicBeta': readonly string[];
};
export type AnthropicMessagesCountBodyOutput = HttpOutput & UsageFacts & {
  readonly 'response.targetApi': 'anthropicMessages';
};
type CountTargets = {
  readonly egress: StaticTarget<ChatEgressInput<'anthropicMessages'>, AnthropicMessagesCountEgressOutput, GatewayServices>;
};

const routeCount = defineEnding<AnthropicMessagesCountBodyInput, AnthropicMessagesCountBodyOutput, CountTargets>({
  name: 'routeBody',
  request: { needs: ['request.anthropicMessages', 'request.http', 'request.anthropicBeta', 'route.candidate'] },
  into: {
    egress: {
      request: { needs: [], consumes: ['request.anthropicMessages'], provides: ['request.payload'] },
      response: { needs: ['response.http', 'response.targetApi'], consumes: [], provides: [...usageResponseKeys] },
    },
  },
  execute: async ({ 'request.anthropicMessages': payload, ...facts }, into, env) => {
    const response = await into.egress({ ...facts, 'request.payload': payload });
    return { ...response, ...emptyUsageFacts(env) };
  },
});

export const createAnthropicMessagesCountBody = (targets: CountTargets) =>
  compose<AnthropicMessagesCountBodyInput, AnthropicMessagesCountBodyOutput, GatewayServices, CountTargets>('anthropicMessagesCountTokens.body', {
    stages: [pickTarget(anthropicMessagesCountTokensTarget), prepareCount, prepareWebSearchCount, ...requestStages],
    ending: routeCount,
    targets,
  });
