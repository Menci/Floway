import type { GatewayFacts, ProviderServices } from './pipelines.ts';
import { isHttpBodyStream, materializeHeaders, readHttpBody, readHttpResponseBody, responseHeaderEntries, type HttpBody, type HttpResponseFact, type HttpStreamError } from '@floway-dev/http';
import { factSpace, move, type Result } from '@floway-dev/pipeline';

export interface ProviderTransportFacts {
  readonly 'response.transport': Result<HttpResponseFact, HttpStreamError>;
}

const { defineStage } = factSpace<GatewayFacts & ProviderTransportFacts, ProviderServices>();

const fetchBody = async (body: HttpBody): Promise<Result<string | Uint8Array<ArrayBuffer> | null, HttpStreamError>> => {
  if (body === null || typeof body === 'string') return { ok: true, value: body };
  if (!(body instanceof Uint8Array) && !isHttpBodyStream(body)) return { ok: true, value: JSON.stringify(body) };

  // The proxy and direct-connect routes can replay bytes across dial attempts.
  const bytes = await readHttpBody(body);
  if (!bytes.ok) return bytes;
  const value = bytes.value.buffer instanceof ArrayBuffer
    ? bytes.value as Uint8Array<ArrayBuffer>
    : new Uint8Array(bytes.value);
  return { ok: true, value };
};

export const httpTerminal = defineStage({
  name: 'http',
  request: { needs: ['request.http', 'provider.upstream'] },
  return: { provides: ['response.transport'] },
  async execute({ 'request.http': request, 'provider.upstream': upstream }, scope) {
    const body = await fetchBody(request.body);
    if (!body.ok) return { 'response.transport': move(body) };

    const send = scope.services.fetcher(upstream.id);
    const result = await send(request.url, {
      method: request.method,
      headers: materializeHeaders(request.headers),
      body: body.value,
      signal: scope.signal,
    });
    if (!result.ok) return { 'response.transport': move(result) };

    const { body: readable, status, statusText } = result.value;
    return {
      'response.transport': move({
        ok: true,
        value: {
          status,
          statusText,
          headers: responseHeaderEntries(result.value),
          body: readable === null ? null : scope.createStream(({ signal }) => readHttpResponseBody(readable, signal)),
        },
      } as const),
    };
  },
});
