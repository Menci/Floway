import { scheduleOllamaAccountProbe } from '../account-probe.ts';
import type { OllamaUpstreamConfig } from '../config.ts';
import type { OllamaUpstreamState } from '../state.ts';
import { scheduleOllamaUsageProbe } from '../usage-probe.ts';
import type { HttpRequestFacts } from '@floway-dev/http/pipeline';
import { defer, defineStage, move, type Deferred } from '@floway-dev/pipeline';
import type { ProviderResponse, ProviderServices } from '@floway-dev/provider';

type ProbeResponse = ProviderResponse & { 'response.ollama.probes': Deferred<unknown> };

export const observeOllamaAccount = (upstreamId: string, config: OllamaUpstreamConfig, state: OllamaUpstreamState) => {
  const observeAccount = defineStage<Pick<HttpRequestFacts, 'request.http.callId'>, Pick<HttpRequestFacts, 'request.http.callId'>, ProviderResponse, ProbeResponse, ProviderServices>({
    name: 'observeOllamaAccount',
    through: {
      request: { needs: ['request.http.callId'], consumes: [], provides: [] },
      response: { needs: ['response.http.exchange'], consumes: [], provides: ['response.ollama.probes'] },
    },
    execute: async (facts, next, use) => {
      const back = await next(move({ ...facts }));
      const pending: Promise<unknown>[] = [];
      if (back['response.http.exchange'].type === 'response') {
        const call = use.httpCall(facts['request.http.callId']);
        const background = (work: Promise<unknown>): void => { pending.push(work); };
        scheduleOllamaUsageProbe(upstreamId, config, state, call.fetcher, background);
        scheduleOllamaAccountProbe(upstreamId, config, state, call.fetcher, background);
      }
      return move({ ...back, 'response.ollama.probes': defer(Promise.all(pending)) });
    },
  });
  return observeAccount;
};
