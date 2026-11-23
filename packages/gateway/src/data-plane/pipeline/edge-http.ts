import parseHttpDate from 'http-dates';

import { type HttpRequestFacts, type HttpResponseFacts, isTransportFailure } from '@floway-dev/http';
import { Bytes, defineStage, type Deferred, type ErrorSnapshot, isManagedStream, type Scope, snapshotError } from '@floway-dev/pipeline';

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

// https://www.rfc-editor.org/rfc/rfc9110.html#section-10.2.3
export const httpRetryTime = (http: HttpResponseFacts): number | null => {
  const header = http.headers.find(([name]) => name.toLowerCase() === 'retry-after')?.[1];
  const value = typeof header === 'string' ? header.trim() : header?.reveal().trim();
  if (!value) return null;
  const now = Date.now();
  if (/^\d+(?:\.\d+)?$/.test(value)) {
    const time = now + Number(value) * 1000;
    return Number.isFinite(time) ? time : null;
  }
  try {
    return Math.max(now, parseHttpDate(value).getTime());
  } catch (_invalidDate: unknown) {
    return null;
  }
};

export const wrapHttpDelivery = (http: HttpResponseFacts, scope: Pick<Scope, 'clock' | 'defer' | 'deferred' | 'wrapStream'>): HttpOutput & HttpDeliveryFacts => {
  const { body } = http;
  if (!isManagedStream(body)) {
    return { 'response.http': http, 'response.delivery': scope.defer<HttpDelivery>('HTTP delivery', Promise.resolve({ kind: 'completed', endedAt: scope.clock() })) };
  }
  let transportFailure: ErrorSnapshot | undefined;
  const output = scope.wrapStream(body, {
    label: 'downstream HTTP body',
    async *transform(source, scope) {
      for await (const chunk of source) {
        if (isTransportFailure(chunk)) {
          transportFailure = chunk.error;
          delivery.resolve({ kind: 'write-failed', endedAt: scope.clock(), error: chunk.error });
          yield chunk;
          return;
        }
        yield chunk;
      }
    },
    onClose: end => {
      if (transportFailure !== undefined) return;
      const endedAt = scope.clock();
      if (end.how === 'errored' || end.how === 'leaked') {
        delivery.resolve({ kind: 'write-failed', endedAt, error: snapshotError(end.how === 'errored' ? end.error : new Error('Downstream HTTP body leaked')) });
      } else {
        delivery.resolve({ kind: end.how === 'exhausted' ? 'completed' : 'client-cancelled', endedAt });
      }
    },
  });
  const delivery = scope.deferred<HttpDelivery>('HTTP delivery', output);
  return { 'response.http': { ...http, body: output }, 'response.delivery': delivery.deferred };
};

export const edgeHttp = defineStage<HttpInput, HttpInput, HttpOutput, HttpOutput & HttpDeliveryFacts>({
  name: 'edgeHttp',
  through: {
    request: { needs: ['request.http'], consumes: [], provides: [] },
    response: { needs: ['response.http'], consumes: [], provides: ['response.http', 'response.delivery'] },
  },
  execute: async (request, scope) => {
    const response = await scope.next(request);
    return { ...response, ...wrapHttpDelivery(response['response.http'], scope) };
  },
});

const flowayAuthHeaders = new Set(['authorization', 'x-api-key', 'x-goog-api-key', 'x-floway-session']);

export const stripFlowayAuth = defineStage<HttpInput, HttpInput, HttpOutput, HttpOutput>({
  name: 'stripFlowayAuth',
  through: {
    request: { needs: ['request.http'], consumes: [], provides: ['request.http'] },
    response: { needs: [], consumes: [], provides: [] },
  },
  execute: async (facts, scope) => {
    const http = facts['request.http'];
    const headers = http.headers.filter(([name]) => !flowayAuthHeaders.has(name.toLowerCase()));
    return await scope.next(headers.length === http.headers.length ? facts : { ...facts, 'request.http': { ...http, headers } });
  },
});
