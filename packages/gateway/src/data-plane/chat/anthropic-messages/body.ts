import type { AnthropicMessagesCountEgressOutput } from './egress.ts';
import { anthropicMessagesInputErrorBody } from './errors.ts';
import { answerClaudeCodeProbe } from './stages/answer-claude-code-probe.ts';
import { disableReasoningOnForcedToolChoice } from './stages/disable-reasoning-on-forced-tool-choice.ts';
import { normalizeEmptyToolsToolChoice } from './stages/normalize-empty-tools-tool-choice.ts';
import { prepareCount } from './stages/prepare-count.ts';
import { prepareGenerate } from './stages/prepare-generate.ts';
import { prepareWebSearchCount } from './stages/prepare-web-search-count.ts';
import { stripBillingAttribution } from './stages/strip-billing-attribution.ts';
import { webSearchShim } from './stages/web-search-shim.ts';
import type { HttpOutput } from '../../pipeline/edge-http.ts';
import type { GatewayServices } from '../../pipeline/services.ts';
import { removeFact } from '../shared/remove-fact.ts';
import { type ChatBodyInput, type ChatBodyOutput, type ChatBodyTargets, type ChatEgressInput, createAnthropicMessagesRouteBody } from '../shared/route-body.ts';
import { anthropicMessagesCountTokensTarget, anthropicMessagesGenerateTarget, pickTarget } from '../shared/target-picker.ts';
import { compose, defineEnding, type StaticTarget } from '@floway-dev/pipeline';
import type { HttpOutcome } from '@floway-dev/provider';

type MessagesBodyInput = ChatBodyInput<'anthropicMessages'>;
type MessagesBodyOutput = ChatBodyOutput<'anthropicMessages'>;
type MessagesBodyTargets = ChatBodyTargets<'anthropicMessages'>;

const entry = [
  'request.http', 'request.auth.apiKeyId', 'request.auth.user', 'request.route.upstreamIds',
  'request.route.randomizeUpstreams', 'request.route.runtimeLocation', 'route.candidate',
  'request.anthropicMessages', 'request.anthropicBeta',
] as const;
const exit = ['response.http', 'response.anthropicMessages'] as const;
const countExit = ['response.http', 'response.anthropicMessagesCountTokens'] as const;
const requestStages = [stripBillingAttribution, disableReasoningOnForcedToolChoice, normalizeEmptyToolsToolChoice];

export const createAnthropicMessagesBody = (targets: MessagesBodyTargets) =>
  compose<MessagesBodyInput & MessagesBodyOutput, GatewayServices>()('anthropicMessages.body', {
    entry, exit,
    stages: [pickTarget(anthropicMessagesGenerateTarget), prepareGenerate, answerClaudeCodeProbe, webSearchShim, ...requestStages],
    ending: createAnthropicMessagesRouteBody(anthropicMessagesInputErrorBody),
    targets,
  });

export type AnthropicMessagesCountBodyInput = MessagesBodyInput;
export type AnthropicMessagesCountBodyOutput = HttpOutput & {
  readonly 'response.anthropicMessagesCountTokens': HttpOutcome;
};
type CountTargets = {
  readonly egress: StaticTarget<ChatEgressInput<'anthropicMessages'>, AnthropicMessagesCountEgressOutput, GatewayServices>;
};

type CountRouteInput = AnthropicMessagesCountBodyInput & Pick<ChatEgressInput<'anthropicMessages'>, 'route.targetApi'>;
const routeCount = defineEnding<CountRouteInput, AnthropicMessagesCountBodyOutput, CountTargets>({
  name: 'routeBody',
  request: { needs: ['request.anthropicMessages', 'request.http', 'request.anthropicBeta', 'route.candidate', 'route.targetApi'] },
  into: {
    egress: {
      request: { needs: [], consumes: ['request.anthropicMessages'], provides: ['request.payload'] },
      response: { needs: [...countExit, 'response.modelKey'], consumes: ['response.modelKey'], provides: [] },
    },
  },
  execute: async ({ 'request.anthropicMessages': payload, ...facts }, scope) => {
    const response = await scope.into.egress({ ...facts, 'request.payload': payload });
    return removeFact<AnthropicMessagesCountBodyOutput, 'response.modelKey'>(response, 'response.modelKey');
  },
});

export const createAnthropicMessagesCountBody = (targets: CountTargets) =>
  compose<AnthropicMessagesCountBodyInput & AnthropicMessagesCountBodyOutput, GatewayServices>()('anthropicMessagesCountTokens.body', {
    entry, exit: countExit,
    stages: [pickTarget(anthropicMessagesCountTokensTarget), prepareCount, prepareWebSearchCount, ...requestStages],
    ending: routeCount,
    targets,
  });
