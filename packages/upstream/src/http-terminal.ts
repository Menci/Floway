import type { UpstreamRequestFacts } from './pipeline-facts.ts';
import { sendHttpRequest, type Fetcher, type HttpResponseFact, type HttpStreamError } from '@floway-dev/http';
import { factSpace } from '@floway-dev/pipeline';

export interface UpstreamHttpServices {
  fetcher(upstreamId: string): Fetcher;
}

export interface UpstreamHttpResponseFacts {
  http: HttpResponseFact | null;
  'http.error': HttpStreamError;
}

const { defineStage } = factSpace<Pick<UpstreamRequestFacts, 'http' | 'upstream'>, UpstreamHttpResponseFacts, UpstreamHttpServices>();

export const httpTerminal = defineStage({
  name: 'http',
  request: { needs: ['http', 'upstream'] },
  return: { provides: ['http', 'http.error?'] },
  async execute({ http, upstream }, scope) {
    const { body, ...request } = http;
    if (body !== null && typeof body !== 'string' && !(body instanceof Uint8Array)) {
      throw new TypeError('The upstream dial stage must serialize the HTTP request body');
    }
    const sent = await sendHttpRequest(scope.services.fetcher(upstream.id), { ...request, body }, scope.signal);
    if (!sent.ok) return { http: null, 'http.error': sent.error };

    const { body: source, ...response } = sent.value;
    return { http: { ...response, body: source === null ? null : scope.createStream(() => source) } };
  },
});
