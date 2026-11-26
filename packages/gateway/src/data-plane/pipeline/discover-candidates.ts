import { defineOperationStage, type Candidate, type GatewayPipelineFacts } from './facts.ts';
import { toProviderUpstream } from '../providers/registry.ts';
import type { HttpRequestFact, HttpResponseFact } from '@floway-dev/http';
import type { ModelKind } from '@floway-dev/protocols/common';
import { toProviderModelFact, type ProtocolError, type ProviderModelFact, type ProviderOperation } from '@floway-dev/provider';

interface ModelUnavailable {
  model: string;
  exists: boolean;
  failedUpstreams: readonly string[];
  incompatibilities: readonly string[];
}

export const discoverCandidates = <Op extends ProviderOperation>(operation: Op, options: {
  kind: ModelKind;
  model: 'request.model' | ((payload: GatewayPipelineFacts[`request.${Op}`], http: HttpRequestFact) => string);
  supports(model: ProviderModelFact, payload: GatewayPipelineFacts[`request.${Op}`]): boolean;
  incompatibility?(model: ProviderModelFact, payload: GatewayPipelineFacts[`request.${Op}`]): string | null;
  unavailable(input: ModelUnavailable): { http: HttpResponseFact; outcome: ProtocolError };
}) => {
  const payload = `request.${operation}` as const;
  const outcome: string = `response.${operation}`;
  const requestNeeds: readonly string[] = [payload, 'request.http', 'request.auth.userId', 'request.auth.isAdmin', 'request.auth.upstreamIds', 'request.auth.randomizeUpstreams', 'serve.runtimeLocation',
    ...(options.model === 'request.model' ? ['request.model'] : [])];
  const returnProvides: readonly string[] = ['response.http', outcome, 'response.requestedModel'];
  return defineOperationStage({
    name: `${operation}.discover-candidates`,
    through: {
      request: {
        needs: requestNeeds,
        provides: ['request.candidates'],
        consumes: [],
      },
      response: { needs: [], provides: [], consumes: [] },
    },
    return: { provides: returnProvides },
    async execute(facts, scope) {
      const request = facts[payload] as GatewayPipelineFacts[typeof payload];
      const model = options.model === 'request.model'
        ? facts['request.model'] as string
        : options.model(request, facts['request.http'] as HttpRequestFact);
      const { candidates, sawModel, failedUpstreams } = await scope.services.catalogCandidates({
        subject: { id: facts['request.auth.userId'] as number, isAdmin: facts['request.auth.isAdmin'] as boolean },
        upstreamIds: facts['request.auth.upstreamIds'] as readonly string[] | null,
        randomizeUpstreams: facts['request.auth.randomizeUpstreams'] as boolean,
        model,
        kind: options.kind,
        scheduler: work => scope.detach(async () => await work),
        runtimeLocation: facts['serve.runtimeLocation'] as string,
      });
      const viable: Candidate[] = [];
      const incompatibilities = new Set<string>();
      for (const candidate of candidates) {
        const { provider, rules } = candidate;
        const providerModel = candidate.model.providerModels?.[provider.upstreamId];
        if (!providerModel) throw new Error(`Missing model metadata for ${model} on ${provider.upstreamId}`);
        const selected = toProviderModelFact(providerModel);
        if (!options.supports(selected, request)) continue;
        const incompatibility = options.incompatibility?.(selected, request);
        if (incompatibility != null) {
          incompatibilities.add(incompatibility);
          continue;
        }
        viable.push({
          upstream: toProviderUpstream(provider.record),
          model: selected,
          ...(rules === undefined ? {} : { rules }),
        });
      }
      if (viable.length > 0) return await scope.next({ ...facts, 'request.candidates': viable });
      const failure = options.unavailable({ model, exists: sawModel, failedUpstreams, incompatibilities: [...incompatibilities] });
      return { 'response.http': failure.http, [outcome]: failure.outcome, 'response.requestedModel': model };
    },
  });
};
