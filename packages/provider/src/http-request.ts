import { filterHeaders, mergeHeaders, setHeader } from './headers.ts';
import type { ProviderBaseOutput, ProviderServices } from './pipelines.ts';
import { encodeJsonRequest, encodeMultipartFormData, type ProviderRequestBody } from './request-body.ts';
import type { HttpOutput } from './response-body.ts';
import { wrapSensitiveHeaderEntries, type HeaderEntry, type HttpRequestFacts } from '@floway-dev/http';
import { Bytes, defineStage, isManagedStream, type Scope } from '@floway-dev/pipeline';

export interface ProviderHttpRequest extends Omit<HttpRequestFacts, 'body'> {
  readonly body: ProviderRequestBody;
}

export interface ProviderHttpRequestUpdate extends Omit<ProviderHttpRequest, 'headers'> {
  readonly headers?: readonly HeaderEntry[] | ((current: readonly HeaderEntry[]) => readonly HeaderEntry[]);
}

export const encodeHttpRequest = (request: ProviderHttpRequest): HttpRequestFacts => {
  const { body, headers } = request;
  const wrapped = wrapSensitiveHeaderEntries(headers);
  if (body === null || body instanceof Bytes || isManagedStream(body)) return { ...request, headers: wrapped, body };
  if (body.kind === 'json') {
    return {
      ...request,
      headers: setHeader(wrapped, 'content-type', 'application/json'),
      body: encodeJsonRequest(body.value),
    };
  }
  const boundary = `----FlowayFormBoundary${crypto.randomUUID().replaceAll('-', '')}`;
  return {
    ...request,
    headers: setHeader(wrapped, 'content-type', `multipart/form-data; boundary=${boundary}`),
    body: encodeMultipartFormData(body.parts, boundary),
  };
};

export const rewriteHttpRequest = (current: HttpRequestFacts, update: ProviderHttpRequestUpdate): HttpRequestFacts => {
  const { headers, ...request } = update;
  const updated = typeof headers === 'function' ? headers(current.headers) : mergeHeaders(current.headers, headers ?? []);
  return encodeHttpRequest({ ...request, headers: updated });
};

interface ProviderRequest {
  readonly request: ProviderHttpRequestUpdate;
  readonly modelKey: string;
}

type HttpInput = { readonly 'request.http': HttpRequestFacts };

export const stripHttpHeaders = (keep: (lowercaseName: string) => boolean, name = 'stripHttpHeaders') =>
  defineStage<HttpInput, HttpInput, {}, {}>({
    name,
    through: {
      request: { needs: ['request.http'], consumes: [], provides: ['request.http'] },
      response: { needs: [], consumes: [], provides: [] },
    },
    async execute(facts, scope) {
      const request = facts['request.http'];
      return await scope.next({ ...facts, 'request.http': { ...request, headers: filterHeaders(request.headers, keep) } });
    },
  });

export const rewriteHttpRequestStage = <Input, S extends ProviderServices = ProviderServices>(
  name: string,
  needs: readonly (keyof Input & string)[],
  build: (facts: Input & HttpInput, scope: Scope<S>) => ProviderRequest | Promise<ProviderRequest>,
) => defineStage<Input & HttpInput, Input & HttpInput, HttpOutput, ProviderBaseOutput, S>({
  name,
  through: {
    request: { needs: [...new Set(['request.http', ...needs])], consumes: [], provides: ['request.http'] },
    response: { needs: ['response.http'], consumes: [], provides: ['response.modelKey'] },
  },
  async execute(facts, scope) {
    const { request, modelKey } = await build(facts, scope);
    const result = await scope.next({ ...facts, 'request.http': rewriteHttpRequest(facts['request.http'], request) });
    return { ...result, 'response.modelKey': modelKey };
  },
});
