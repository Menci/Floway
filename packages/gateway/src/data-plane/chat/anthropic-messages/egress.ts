import type { GatewayServices } from '../../pipeline/services.ts';
import { filterInboundHeaderEntries } from '../../shared/inbound-headers.ts';
import { applyRulesToUpstreamAnthropicMessages } from '../shared/alias-rules.ts';
import { observeAnthropicMessagesUsage } from '../shared/observe-usage.ts';
import type { ChatEgressInput, ChatEgressOutput } from '../shared/route-body.ts';
import { compose, defineEnding, defineStage, type DynamicTarget, type Pipeline, transform } from '@floway-dev/pipeline';
import type { AnthropicMessagesStreamEventEx } from '@floway-dev/protocols/anthropic-messages';
import type { ProviderAnthropicInput, ProviderHttpOutput, ProviderPipelines, ProviderServices, ProviderStreamOutput } from '@floway-dev/provider';

type EgressInput = ChatEgressInput<'anthropicMessages'>;
type ProviderRequest = EgressInput & Pick<ProviderAnthropicInput, 'request.anthropicBeta'>;
interface UpstreamAnswer {
  readonly 'response.targetApi': 'anthropicMessages';
  readonly 'response.source': 'upstream';
}
export type AnthropicMessagesCountEgressOutput = ProviderHttpOutput & UpstreamAnswer;

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

const providerTarget = <Output extends ProviderHttpOutput>(
  operation: 'anthropicMessages' | 'anthropicMessagesCountTokens',
  select: (pipelines: ProviderPipelines) => Pipeline<ProviderAnthropicInput, Output, ProviderServices> | undefined,
  exit: readonly string[],
) => {
  type Targets = { provider: DynamicTarget<string, ProviderAnthropicInput, Output, GatewayServices> };
  const targets: Targets = {
    provider: {
      entry: ['provider.model', 'request.headers', 'request.payload', 'request.anthropicBeta'],
      exit,
      resolve: (upstreamId, { providers }) => {
        const pipeline = select(providers.resolve(upstreamId).pipelines);
        if (pipeline === undefined) throw new Error(`Upstream ${upstreamId} has no ${operation} pipeline`);
        return pipeline;
      },
    },
  };
  const ending = defineEnding<ProviderRequest, Output & UpstreamAnswer, Targets, Pick<GatewayServices, 'providers'>>({
    name: 'enterUpstream',
    request: { needs: ['request.http', 'request.payload', 'request.anthropicBeta', 'route.candidate'] },
    into: {
      provider: {
        request: { needs: [], consumes: ['request.http'], provides: ['provider.model', 'request.headers', 'request.payload'] },
        response: { needs: exit, consumes: [], provides: ['response.targetApi', 'response.source'] },
      },
    },
    execute: async ({ 'request.http': http, ...facts }, into, env) => {
      const candidate = facts['route.candidate'];
      const provider = env.services.providers.resolve(candidate.upstreamId);
      const { model: _model, ...payload } = facts['request.payload'];
      const response = await into.provider(candidate.upstreamId, {
        ...facts,
        'provider.model': candidate.providerModel,
        'request.headers': filterInboundHeaderEntries(http.headers, provider.inboundHeaderAllowlist),
        'request.payload': payload,
      });
      return { ...response, 'response.targetApi': 'anthropicMessages', 'response.source': 'upstream' };
    },
  });
  return { ending, targets };
};

const generate = providerTarget<ProviderStreamOutput<AnthropicMessagesStreamEventEx>>(
  'anthropicMessages', pipelines => pipelines.anthropicMessages, ['response.http', 'response.modelKey', 'response.events'],
);
const count = providerTarget<ProviderHttpOutput>(
  'anthropicMessagesCountTokens', pipelines => pipelines.anthropicMessagesCountTokens, ['response.http', 'response.modelKey'],
);

export const anthropicMessagesEgress = compose<EgressInput, ChatEgressOutput<'anthropicMessages'>, GatewayServices, typeof generate.targets>(
  'anthropicMessages.egress', { ...generate, stages: [observeAnthropicMessagesUsage, applyAliasRules] },
);

export const anthropicMessagesCountEgress = compose<EgressInput, AnthropicMessagesCountEgressOutput, GatewayServices, typeof count.targets>(
  'anthropicMessagesCountTokens.egress', { ...count, stages: [applyAliasRules] },
);
