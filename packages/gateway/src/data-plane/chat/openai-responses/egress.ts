import { applyAliasRules } from './stages/apply-alias-rules.ts';
import { applyRoleCompatibility } from './stages/apply-role-compatibility.ts';
import { normalizeExclusiveCachedTokens } from './stages/normalize-exclusive-cached-tokens.ts';
import type { GatewayServices } from '../../pipeline/services.ts';
import { filterInboundHeaderEntries } from '../../shared/inbound-headers.ts';
import { observeOpenAIResponsesUsage } from '../shared/observe-usage.ts';
import type { ChatEgressInput, ChatEgressOutput } from '../shared/route-body.ts';
import { compose, defineEnding, type DynamicTarget } from '@floway-dev/pipeline';
import type { CanonicalOpenAIResponsesPayload } from '@floway-dev/protocols/openai-responses';
import type { OpenAIResponsesAction, ProviderResponsesInput, ProviderResponsesOutput } from '@floway-dev/provider';

type EgressInput = ChatEgressInput<'openaiResponses'>;
type Request = Omit<EgressInput, 'request.payload'> & {
  readonly 'request.payload': CanonicalOpenAIResponsesPayload;
};
type EgressOutput = ChatEgressOutput<'openaiResponses'> & Pick<ProviderResponsesOutput, 'response.result'>;
type ProviderBack = ProviderResponsesOutput & {
  readonly 'response.targetApi': 'openaiResponses';
  readonly 'response.source': 'upstream';
};
type Targets = { provider: DynamicTarget<string, ProviderResponsesInput, ProviderResponsesOutput, GatewayServices> };

const providerEntry = ['provider.model', 'request.headers', 'request.payload', 'request.action'];
const providerExit = ['response.http', 'response.modelKey', 'response.events', 'response.result'];

const enterUpstream = (action: OpenAIResponsesAction) => defineEnding<Request, ProviderBack, Targets, Pick<GatewayServices, 'providers'>>({
  name: 'enterUpstream',
  request: { needs: ['request.http', 'request.payload', 'route.candidate'] },
  into: {
    provider: {
      request: { needs: [], consumes: ['request.http'], provides: providerEntry },
      response: { needs: providerExit, consumes: [], provides: ['response.source', 'response.targetApi'] },
    },
  },
  execute: async ({ 'request.http': http, 'request.payload': payload, ...facts }, into, env) => {
    const candidate = facts['route.candidate'];
    const provider = env.services.providers.resolve(candidate.upstreamId);
    const { model: _model, ...wirePayload } = payload;
    const response = await into.provider(candidate.upstreamId, {
      ...facts,
      'provider.model': candidate.providerModel,
      'request.headers': filterInboundHeaderEntries(http.headers, provider.inboundHeaderAllowlist),
      'request.payload': wirePayload,
      'request.action': action,
    });
    return { ...response, 'response.source': 'upstream', 'response.targetApi': 'openaiResponses' };
  },
});

const targets: Targets = {
  provider: {
    entry: providerEntry,
    exit: providerExit,
    resolve(upstreamId, { providers }) {
      const pipeline = providers.resolve(upstreamId).pipelines.openaiResponses;
      if (pipeline === undefined) throw new Error(`Upstream ${upstreamId} has no OpenAI Responses pipeline`);
      return pipeline;
    },
  },
};

const responsesEgress = (name: string, action: OpenAIResponsesAction) => compose<EgressInput, EgressOutput, GatewayServices, Targets>(name, {
  stages: [observeOpenAIResponsesUsage, applyRoleCompatibility, normalizeExclusiveCachedTokens, applyAliasRules],
  targets,
  ending: enterUpstream(action),
});

export const openaiResponsesEgress = responsesEgress('openai-responses.egress', 'generate');
export const openaiResponsesCompactEgress = responsesEgress('openai-responses.compact.egress', 'compact');
