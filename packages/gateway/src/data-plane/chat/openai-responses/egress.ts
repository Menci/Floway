import { applyAliasRules } from './stages/apply-alias-rules.ts';
import { applyRoleCompatibility } from './stages/apply-role-compatibility.ts';
import { normalizeExclusiveCachedTokens } from './stages/normalize-exclusive-cached-tokens.ts';
import { billableUsageFromOpenAIResponsesEvent, billableUsageFromOpenAIResponsesResult } from './usage.ts';
import { createObserveUsage, observedTokenUsage } from '../../pipeline/observe-usage.ts';
import type { GatewayServices } from '../../pipeline/services.ts';
import { filterInboundHeaderEntries } from '../../shared/inbound-headers.ts';
import { firstOutputTokenSignal } from '../shared/first-output-token.ts';
import type { ChatEgressInput, ChatEgressOutput } from '../shared/route-body.ts';
import { compose, defineEnding, type DynamicTarget } from '@floway-dev/pipeline';
import type { BillableUsage } from '@floway-dev/protocols/common';
import type { CanonicalOpenAIResponsesPayload, OpenAIResponsesCompactionResultEx, OpenAIResponsesStreamEventEx } from '@floway-dev/protocols/openai-responses';
import type { OpenAIResponsesAction, ProviderResponsesInput, ProviderResponsesOutput } from '@floway-dev/provider';

type EgressInput = ChatEgressInput<'openaiResponses'>;
type Request = Omit<EgressInput, 'request.payload' | 'request.action'> & {
  readonly 'request.payload': CanonicalOpenAIResponsesPayload;
  readonly 'request.action': OpenAIResponsesAction;
};
type EgressOutput = ChatEgressOutput<'openaiResponses'> & Pick<ProviderResponsesOutput, 'response.result'>;
type ProviderBack = ProviderResponsesOutput & { readonly 'response.targetApi': 'openaiResponses' };
type Targets = { provider: DynamicTarget<string, ProviderResponsesInput, ProviderResponsesOutput, GatewayServices> };

const providerEntry = ['provider.model', 'request.headers', 'request.payload', 'request.action'];
const providerExit = ['response.http', 'response.modelKey', 'response.events', 'response.result'];

const enterUpstream = defineEnding<Request, ProviderBack, Targets, Pick<GatewayServices, 'providers'>>({
  name: 'enterUpstream',
  request: { needs: ['request.http', 'request.payload', 'request.action', 'route.candidate'] },
  into: {
    provider: {
      request: { needs: [], consumes: ['request.http'], provides: ['provider.model', 'request.headers', 'request.payload'] },
      response: { needs: providerExit, consumes: [], provides: ['response.targetApi'] },
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
    });
    return { ...response, 'response.targetApi': 'openaiResponses' };
  },
});

const observeUsage = createObserveUsage<OpenAIResponsesStreamEventEx, OpenAIResponsesCompactionResultEx>({
  scalar: result => observedTokenUsage(billableUsageFromOpenAIResponsesResult(result)),
  open: () => {
    let usage: BillableUsage | null = null;
    return {
      frame(frame) {
        if (frame.type !== 'event') return;
        usage = billableUsageFromOpenAIResponsesEvent(frame.event) ?? usage;
        return {
          output: firstOutputTokenSignal(frame, 'openaiResponses') !== null,
          failed: frame.event.type === 'error' || frame.event.type === 'response.failed',
        };
      },
      usage: () => observedTokenUsage(usage),
    };
  },
});

export const openaiResponsesEgress = compose<EgressInput, EgressOutput, GatewayServices, Targets>('openai-responses.egress', {
  stages: [observeUsage, applyRoleCompatibility, normalizeExclusiveCachedTokens, applyAliasRules],
  targets: {
    provider: {
      entry: providerEntry,
      exit: providerExit,
      resolve(upstreamId, { providers }) {
        const pipeline = providers.resolve(upstreamId).pipelines.openaiResponses;
        if (pipeline === undefined) throw new Error(`Upstream ${upstreamId} has no OpenAI Responses pipeline`);
        return pipeline;
      },
    },
  },
  ending: enterUpstream,
});
