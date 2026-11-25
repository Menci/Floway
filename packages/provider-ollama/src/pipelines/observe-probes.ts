import type { OllamaServices } from '../service.ts';
import { isOllamaUsageEnabled } from '../usage-probe.ts';
import { upstreamConfig } from './prepare-request.ts';
import { getHeader } from '@floway-dev/http';
import { factSpace, transform } from '@floway-dev/pipeline';
import { isEventStreamMediaType } from '@floway-dev/protocols/common';
import type { GatewayFacts, ProviderTransportFacts } from '@floway-dev/provider';

const { defineStage } = factSpace<Pick<GatewayFacts, 'provider.upstream'> & ProviderTransportFacts, OllamaServices>();

const observe = (requiresSse: boolean) => defineStage({
  name: 'ollama.observeProbes',
  through: {
    request: { needs: ['provider.upstream'], provides: [], consumes: [] },
    response: { needs: ['response.transport'], provides: [], consumes: [] },
  },
  execute: transform(scope => {
    let upstream: GatewayFacts['provider.upstream'];
    return {
      request: facts => {
        upstream = facts['provider.upstream'];
        return facts;
      },
      response: back => {
        const transport = back['response.transport'];
        if (!transport.ok || !isOllamaUsageEnabled(upstreamConfig(upstream))) return back;
        const { body, headers, status } = transport.value;
        if (requiresSse && status >= 200 && status < 300) {
          const contentType = getHeader(headers, 'content-type');
          if (body === null || typeof contentType !== 'string' || !isEventStreamMediaType(contentType)) return back;
        }

        const fetcher = scope.services.fetcher(upstream.id);
        scope.defer(scope.services.ollama.refreshProbes(upstream.id, fetcher).then(result => {
          if (!result.ok) scope.log.warn('ollama_probe_refresh_failed', { upstream_id: upstream.id, error: String(result.error) });
        }));
        return back;
      },
    };
  }),
});

export const observeProbes = observe(false);
export const observeStreamingProbes = observe(true);
