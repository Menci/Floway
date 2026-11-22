import type { ProviderHttpOutput, ProviderServices } from './pipelines.ts';
import { encodeJsonRequest, encodeMultipartFormData, type ProviderRequestBody } from './request-body.ts';
import type { HttpOutput } from './response-body.ts';
import { wrapSensitiveHeaderEntries, type HeaderEntry, type HttpRequestFacts } from '@floway-dev/http';
import { Bytes, defineStage, isManagedStream, type StageEnv } from '@floway-dev/pipeline';

export interface ProviderHttpRequest extends Omit<HttpRequestFacts, 'body'> {
  readonly body: ProviderRequestBody;
}

export const encodeHttpRequest = (request: ProviderHttpRequest): HttpRequestFacts => {
  const { body, headers } = request;
  const wrapped = wrapSensitiveHeaderEntries(headers);
  if (body === null || body instanceof Bytes || isManagedStream(body)) return { ...request, headers: wrapped, body };
  const isContentType = ([name]: HeaderEntry): boolean => name.toLowerCase() === 'content-type';
  if (body.kind === 'json') {
    return {
      ...request,
      headers: wrapped.some(isContentType) ? wrapped : [...wrapped, ['content-type', 'application/json']],
      body: encodeJsonRequest(body.value),
    };
  }
  const boundary = `----FlowayFormBoundary${crypto.randomUUID().replaceAll('-', '')}`;
  return {
    ...request,
    headers: [...wrapped.filter(entry => !isContentType(entry)), ['content-type', `multipart/form-data; boundary=${boundary}`]],
    body: encodeMultipartFormData(body.parts, boundary),
  };
};

interface ProviderRequest {
  readonly request: ProviderHttpRequest;
  readonly modelKey: string;
}

type HttpInput = { readonly 'request.http': HttpRequestFacts };

export const buildHttpRequestStage = <Input>(
  name: string,
  needs: readonly (keyof Input & string)[],
  build: (facts: Input, env: StageEnv<ProviderServices>) => ProviderRequest | Promise<ProviderRequest>,
) => defineStage<Input, HttpInput, HttpOutput, ProviderHttpOutput, ProviderServices>({
  name,
  through: {
    request: { needs, consumes: [], provides: ['request.http'] },
    response: { needs: ['response.http'], consumes: [], provides: ['response.modelKey'] },
  },
  async execute(facts, next, env) {
    const { request, modelKey } = await build(facts, env);
    const result = await next({ ...facts, 'request.http': encodeHttpRequest(request) });
    return { ...result, 'response.modelKey': modelKey };
  },
});
