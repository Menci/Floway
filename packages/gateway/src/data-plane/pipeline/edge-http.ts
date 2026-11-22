import type { HttpRequestFacts, HttpResponseFacts } from '@floway-dev/http';
import { Bytes, defineStage, type Deferred, type ErrorSnapshot, isManagedStream, snapshotError, type StageEnv } from '@floway-dev/pipeline';

export interface HttpInput { readonly 'request.http': HttpRequestFacts }
export interface HttpOutput { readonly 'response.http': HttpResponseFacts }

export type HttpDelivery = { readonly kind: 'completed' | 'client-cancelled'; readonly endedAt: number }
  | { readonly kind: 'write-failed'; readonly endedAt: number; readonly error: ErrorSnapshot };

export interface HttpDeliveryFacts {
  readonly 'response.delivery': Deferred<HttpDelivery>;
}

export const jsonHttpResponse = (status: number, body: unknown, now: number): HttpResponseFacts => ({
  status,
  statusText: '',
  headers: [['content-type', 'application/json']],
  body: Bytes.fromUtf8(JSON.stringify(body)),
  timing: { startedAt: now, headersAt: now },
});

export const wrapHttpDelivery = (http: HttpResponseFacts, env: StageEnv): HttpOutput & HttpDeliveryFacts => {
  const { body } = http;
  if (!isManagedStream(body)) {
    return { 'response.http': http, 'response.delivery': env.defer<HttpDelivery>('HTTP delivery', Promise.resolve({ kind: 'completed', endedAt: env.clock() })) };
  }
  const output = env.wrapStream(body, {
    label: 'downstream HTTP body',
    transform: source => source,
    onClose: end => {
      const endedAt = env.clock();
      if (end.how === 'errored' || end.how === 'leaked') {
        delivery.resolve({ kind: 'write-failed', endedAt, error: snapshotError(end.how === 'errored' ? end.error : new Error('Downstream HTTP body leaked')) });
      } else {
        delivery.resolve({ kind: end.how === 'exhausted' ? 'completed' : 'client-cancelled', endedAt });
      }
    },
  });
  const delivery = env.deferred<HttpDelivery>('HTTP delivery', output);
  return { 'response.http': { ...http, body: output }, 'response.delivery': delivery.deferred };
};

export const edgeHttp = defineStage<HttpInput, HttpInput, HttpOutput, HttpOutput & HttpDeliveryFacts>({
  name: 'edgeHttp',
  through: {
    request: { needs: ['request.http'], consumes: [], provides: [] },
    response: { needs: ['response.http'], consumes: [], provides: ['response.http', 'response.delivery'] },
  },
  execute: async (request, next, env) => {
    const response = await next(request);
    return { ...response, ...wrapHttpDelivery(response['response.http'], env) };
  },
});
