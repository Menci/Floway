import type { HttpExchange, HttpRequestFacts, HttpResponseFacts, HttpServices } from './pipeline-types.ts';
import { serializeHttpBody } from './request-content.ts';
import { takeHttpResponse } from './response.ts';
import { defineStage, isSecret, move } from '@floway-dev/pipeline';

export const http = defineStage<HttpRequestFacts, HttpResponseFacts, HttpServices>({
  name: 'http',
  return: { provides: ['response.http.exchange', 'response.http.body'] },
  execute: async (facts, use) => {
    const call = use.httpCall(facts['request.http.callId']);
    const headers = facts['request.http.headers'].map(([name, value]): [string, string] =>
      [name, isSecret(value) ? value.reveal() : value]);
    const body = serializeHttpBody(facts['request.http.body'], facts['request.http.encoding']);
    const init = {
      method: facts['request.http.method'],
      headers,
      body,
      signal: call.signal,
    };
    new URL(facts['request.http.url']);
    new Headers(headers);
    const exchange: HttpExchange = await call.wrapUpstreamCall(async () => {
      let response: Response;
      try {
        response = await call.fetcher(facts['request.http.url'], init);
      } catch (error) {
        use.log.warn('upstream transport failed', { error });
        return { type: 'transportFailure' as const, error };
      }
      return takeHttpResponse(response);
    });
    return move({ ...facts, 'response.http.exchange': exchange, 'response.http.body': exchange.type === 'response' ? exchange.body : null });
  },
});
