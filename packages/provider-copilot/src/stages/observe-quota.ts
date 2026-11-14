import type { QuotaResponse } from '../pipeline-facts.ts';
import { parseCopilotQuotaHeaders, putCopilotQuota } from '../quota.ts';
import type { HttpRequestFacts, HttpResponseFacts } from '@floway-dev/http/pipeline';
import { defer, defineStage, move } from '@floway-dev/pipeline';
import type { ProviderServices } from '@floway-dev/provider';

export const observeCopilotQuota = (upstreamId: string) => {
  const observeQuota = defineStage<Pick<HttpRequestFacts, 'request.http.callId'>, Pick<HttpRequestFacts, 'request.http.callId'>, HttpResponseFacts, QuotaResponse, ProviderServices>({
    name: 'observeCopilotQuota',
    through: {
      request: { needs: ['request.http.callId'], consumes: [], provides: [] },
      response: { needs: ['response.http.exchange'], consumes: [], provides: ['response.copilot.quota'] },
    },
    execute: async (facts, next) => {
      const back = await next(move({ ...facts }));
      const exchange = back['response.http.exchange'];
      const pending: Promise<unknown>[] = [];
      if (exchange.type === 'response') {
        const headers = new Headers(exchange.headers.map(([name, value]): [string, string] => [name, value]));
        let snapshot;
        try {
          snapshot = parseCopilotQuotaHeaders(headers, new Date());
        } catch (error) {
          console.warn(`Failed to parse Copilot quota snapshot for ${upstreamId}:`, error);
        }
        if (snapshot !== undefined && snapshot !== null) {
          pending.push(putCopilotQuota(upstreamId, snapshot).catch((error: unknown) => {
            console.warn(`Failed to persist Copilot quota snapshot for ${upstreamId}:`, error);
          }));
        }
      }
      return move({ ...back, 'response.copilot.quota': defer(Promise.all(pending)) });
    },
  });
  return observeQuota;
};
