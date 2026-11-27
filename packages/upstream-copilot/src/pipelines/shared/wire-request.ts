import { setHeader, type HttpRequestFact, type HttpStreamError } from '@floway-dev/http';
import type { Result } from '@floway-dev/pipeline';
import type { JsonObject } from '@floway-dev/protocols/common';
import { isJsonObject } from '@floway-dev/protocols/common';
import { parseJsonBody } from '@floway-dev/upstream';

export const ERROR_BODY_BYTES = 2 * 1024 * 1024;
export const RESULT_BODY_BYTES = 32 * 1024 * 1024;
export const IMAGE_RESULT_BODY_BYTES = 128 * 1024 * 1024;

export const wireRequest = (
  http: HttpRequestFact,
  url: string,
  body: string | Uint8Array,
  contentType = 'application/json',
): HttpRequestFact => ({
  ...http,
  method: 'POST',
  url,
  headers: setHeader(http.headers, 'content-type', contentType),
  body,
});

export const jsonRequest = (http: HttpRequestFact, path: string, value: object): HttpRequestFact =>
  wireRequest(http, path, JSON.stringify(value));

export const dispatchedAnswer = <Answer extends { 'http.error'?: HttpStreamError }>(
  received: Answer,
  modelId: string,
  catalogModelId: string,
) => {
  const { 'http.error': failure, ...answer } = received;
  if (failure?.kind === 'abort' || modelId === catalogModelId) return { failure, answer };
  return { failure, answer: { ...answer, usageModelKey: modelId } };
};

export const readJsonObject = (bytes: Uint8Array): Result<JsonObject, Error> => {
  const parsed = parseJsonBody(bytes);
  if (!parsed.ok) return parsed;
  if (!isJsonObject(parsed.value)) return { ok: false, error: new Error('Expected an upstream JSON object') };
  return { ok: true, value: parsed.value };
};
