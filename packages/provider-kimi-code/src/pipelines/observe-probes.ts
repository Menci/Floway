import type { KimiCodeServices } from '../service.ts';
import type { KimiCodeUpstreamFact } from '../upstream-fact.ts';
import { factSpace } from '@floway-dev/pipeline';
import type { GatewayFacts, ProviderTransportFacts } from '@floway-dev/provider';

const { defineStage } = factSpace<GatewayFacts & ProviderTransportFacts & { 'provider.upstream': KimiCodeUpstreamFact }, KimiCodeServices>();

export const observeProbes = defineStage({
  name: 'kimi-code.observe-probes',
  through: {
    request: { needs: ['provider.upstream'], provides: [], consumes: [] },
    response: { needs: ['response.transport'], provides: [], consumes: [] },
  },
  async execute(facts, scope) {
    const upstream = facts['provider.upstream'];
    const back = await scope.next(facts);
    const transport = back['response.transport'];
    if (!transport.ok) return back;
    scope.defer(scope.services.kimiCode.observeResponse(upstream, transport.value.status, scope.services.fetcher(upstream.id)).then(result => {
      if (!result.persisted) scope.log.warn('kimi_code_probes_failed', { upstream_id: upstream.id, error: result.error });
      return result;
    }));
    return back;
  },
});
