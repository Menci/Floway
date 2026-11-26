import { setHeader, type HttpRequestFact, type HttpStreamError } from '@floway-dev/http';

interface WireRequest {
  path: string;
  body: Uint8Array;
  contentType: string;
  modelId: string;
}

export const jsonRequest = (path: string, value: object): WireRequest => {
  if (!('model' in value) || typeof value.model !== 'string') throw new TypeError('Copilot JSON request requires a wire model id');
  return {
    path,
    body: new TextEncoder().encode(JSON.stringify(value)),
    contentType: 'application/json',
    modelId: value.model,
  };
};

export const wireRequest = (http: HttpRequestFact, { path, contentType, body }: WireRequest): HttpRequestFact => ({
  ...http,
  method: 'POST',
  url: `${http.url}${path}`,
  headers: setHeader(http.headers, 'content-type', contentType),
  body,
});

export const dispatchedAnswer = <Answer extends { 'response.http.error'?: HttpStreamError }>(received: Answer, { modelId }: WireRequest) => {
  const { 'response.http.error': failure, ...answer } = received;
  return { failure, answer: failure?.kind === 'abort' ? answer : { ...answer, 'response.usageModelKey': modelId } };
};
