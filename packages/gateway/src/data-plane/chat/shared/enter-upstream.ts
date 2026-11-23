import type { ChatEgressInput, ChatPayload } from './route-body.ts';
import type { GatewayServices } from '../../pipeline/services.ts';
import { filterInboundHeaderEntries } from '../../shared/inbound-headers.ts';
import { defineEnding, type DynamicTarget, type Pipeline } from '@floway-dev/pipeline';
import type { ChatTargetApi, ProviderHttpOutput, ProviderInput, ProviderPipelines, ProviderServices } from '@floway-dev/provider';

export const createProviderTarget = <Api extends ChatTargetApi, Output extends ProviderHttpOutput>(
  api: Api,
  operation: keyof ProviderPipelines,
  select: (pipelines: ProviderPipelines) => Pipeline<ProviderInput<Omit<ChatPayload<Api>, 'model'>>, Output, ProviderServices> | undefined,
  exit: readonly string[],
) => {
  type Input = ProviderInput<Omit<ChatPayload<Api>, 'model'>>;
  type TargetApi = { readonly 'response.targetApi': Api; readonly 'response.source': 'upstream' };
  type Targets = { provider: DynamicTarget<string, Input, Output, GatewayServices> };
  const targets: Targets = {
    provider: {
      entry: ['provider.model', 'request.headers', 'request.payload'],
      exit,
      resolve: (upstreamId, { providers }) => {
        const pipeline = select(providers.resolve(upstreamId).pipelines);
        if (pipeline === undefined) throw new Error(`Upstream ${upstreamId} has no ${operation} pipeline`);
        return pipeline;
      },
    },
  };
  const ending = defineEnding<ChatEgressInput<Api>, Output & TargetApi, Targets, Pick<GatewayServices, 'providers'>>({
    name: 'enterUpstream',
    request: { needs: ['request.http', 'request.payload', 'route.candidate'] },
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
      return { ...response, 'response.targetApi': api, 'response.source': 'upstream' };
    },
  });
  return { ending, targets };
};
