import type { GatewayFacts, HttpTerminalFacts, ProviderServices } from './pipeline-facts.ts';
import { sendHttpRequest } from '@floway-dev/http';
import { factSpace } from '@floway-dev/pipeline';

const { defineStage } = factSpace<GatewayFacts & HttpTerminalFacts, ProviderServices>();

export const httpTerminal = defineStage({
  name: 'http',
  request: { needs: ['request.http', 'provider.upstream'] },
  return: { provides: ['response.http', 'response.http.error?'] },
  async execute({ 'request.http': request, 'provider.upstream': upstream }, scope) {
    const sent = await sendHttpRequest(scope.services.fetcher(upstream.id), request, scope.signal);
    if (!sent.ok) return { 'response.http': null, 'response.http.error': sent.error };
    const { body, ...response } = sent.value;
    return { 'response.http': { ...response, body: body === null ? null : scope.createStream(() => body) } };
  },
});
