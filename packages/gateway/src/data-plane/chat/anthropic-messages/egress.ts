import { applyRoleCompatibility } from './stages/apply-role-compatibility.ts';
import { priceCall, recordCall } from '../../pipeline/call-metering.ts';
import type { GatewayServices } from '../../pipeline/services.ts';
import { anthropicMessagesCountTokensProviderTargets, anthropicMessagesProviderTargets } from '../../providers/upstreams.ts';
import { applyRulesToUpstreamAnthropicMessages } from '../shared/alias-rules.ts';
import { createChatProviderEnding } from '../shared/enter-upstream.ts';
import { observeAnthropicMessagesCall } from '../shared/observe-usage.ts';
import type { ChatEgressInput, ChatEgressOutput } from '../shared/route-body.ts';
import { compose, defineStage, transform } from '@floway-dev/pipeline';
import type { ProviderAnthropicCountTokensOutput } from '@floway-dev/provider';

type EgressInput = ChatEgressInput<'anthropicMessages'>;
type EgressOutput = ChatEgressOutput<'anthropicMessages'>;
export type AnthropicMessagesCountEgressOutput = ProviderAnthropicCountTokensOutput;

const applyAliasRules = defineStage<EgressInput, EgressInput, object, object>({
  name: 'applyAliasRules',
  through: {
    request: { needs: ['request.payload', 'route.candidate'], consumes: [], provides: ['request.payload'] },
    response: { needs: [], consumes: [], provides: [] },
  },
  execute: transform(() => ({
    request: facts => {
      const { rules } = facts['route.candidate'];
      if (rules === undefined) return facts;
      const payload = { ...facts['request.payload'] };
      applyRulesToUpstreamAnthropicMessages(payload, rules);
      return { ...facts, 'request.payload': payload };
    },
  })),
});

const entry = [
  'request.http', 'request.auth.apiKeyId', 'request.auth.user', 'request.route.upstreamIds',
  'request.route.randomizeUpstreams', 'request.route.runtimeLocation', 'route.candidate',
  'route.targetApi', 'request.payload', 'request.anthropicBeta',
] as const;
const exit = ['response.http', 'response.modelKey', 'response.anthropicMessages'] as const;
const countExit = ['response.http', 'response.modelKey', 'response.anthropicMessagesCountTokens'] as const;

export const anthropicMessagesEgress = compose<EgressInput & EgressOutput, GatewayServices>()('anthropicMessages.egress', {
  entry, exit,
  stages: [recordCall('chat'), priceCall, observeAnthropicMessagesCall, applyRoleCompatibility, applyAliasRules],
  ending: createChatProviderEnding('anthropicMessages', anthropicMessagesProviderTargets),
  targets: anthropicMessagesProviderTargets,
});

export const anthropicMessagesCountEgress = compose<EgressInput & AnthropicMessagesCountEgressOutput, GatewayServices>()('anthropicMessagesCountTokens.egress', {
  entry, exit: countExit,
  stages: [applyRoleCompatibility, applyAliasRules],
  ending: createChatProviderEnding('anthropicMessagesCountTokens', anthropicMessagesCountTokensProviderTargets),
  targets: anthropicMessagesCountTokensProviderTargets,
});
