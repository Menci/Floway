import type { KimiCodeServices } from '../service.ts';
import { factSpace, transform } from '@floway-dev/pipeline';
import type { GatewayFacts, ProviderTransportFacts } from '@floway-dev/provider';

const { defineStage } = factSpace<GatewayFacts & ProviderTransportFacts, KimiCodeServices>();

export const observeProbes = defineStage({
  name: 'kimi-code.observe-probes',
  through: {
    request: { needs: ['provider.upstream'], provides: [], consumes: [] },
    response: { needs: ['response.transport'], provides: [], consumes: [] },
  },
  execute: transform(scope => {
    let upstream: GatewayFacts['provider.upstream'];
    return {
      request(facts) {
        upstream = facts['provider.upstream'];
        return facts;
      },
      response(back) {
        const transport = back['response.transport'];
        if (!transport.ok) return back;
        const send = scope.services.fetcher(upstream.id);
        scope.defer(scope.services.kimiCode.observeResponse(upstream, transport.value.status, async (url, init) => {
          const result = await send(url, init);
          if (!result.ok) throw result.error.cause;
          return result.value;
        }).then(result => {
          if (!result.persisted) scope.log.warn('kimi_code_probes_failed', { upstream_id: upstream.id, error: result.error });
          return result;
        }));
        return back;
      },
    };
  }),
});
