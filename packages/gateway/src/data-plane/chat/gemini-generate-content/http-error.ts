import { gatewayErrorStatus, geminiGenerateContentInternalErrorPayload, geminiGenerateContentRpcErrorPayload, googleRpcHttpStatusCode, isGeminiGenerateContentErrorResponse } from './errors.ts';
import { forwardHttp, httpSucceeded, readHttpBytes } from '../../pipeline/non-chat.ts';
import { inputErrorFields, type InputErrorDetails } from '../shared/errors.ts';
import type { HttpResponseFacts } from '@floway-dev/http';
import { Bytes } from '@floway-dev/pipeline';
import type { GeminiGenerateContentErrorResponse } from '@floway-dev/protocols/gemini-generate-content';
import { toInternalDebugError } from '@floway-dev/provider';

export const geminiInputErrorBody = (error: InputErrorDetails): GeminiGenerateContentErrorResponse => {
  const body = geminiGenerateContentRpcErrorPayload(400, error.message);
  const extension = inputErrorFields(error);
  return extension === undefined ? body : {
    error: {
      ...body.error,
      details: [{ '@type': 'type.googleapis.com/google.protobuf.Struct', value: extension }],
    },
  };
};

export const geminiInternalErrorBody = (status: number, error: unknown): GeminiGenerateContentErrorResponse =>
  geminiGenerateContentInternalErrorPayload(googleRpcHttpStatusCode(status), toInternalDebugError(error));

export const geminiJsonBody = (http: HttpResponseFacts, body: unknown, status = http.status): HttpResponseFacts => ({
  ...http,
  status,
  statusText: status === http.status ? http.statusText : '',
  headers: [...forwardHttp(http, null).headers.filter(([name]) => name !== 'content-type'), ['content-type', 'application/json']],
  body: Bytes.fromUtf8(JSON.stringify(body)),
});

export const normalizeGeminiFailure = async (http: HttpResponseFacts): Promise<HttpResponseFacts> => {
  if (httpSucceeded(http)) return forwardHttp(http, null);
  const body = await readHttpBytes(http.body);
  const message = body.utf8().trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(message);
  } catch {
    // Providers may return plain text, HTML, or no error body.
  }
  if (isGeminiGenerateContentErrorResponse(parsed)) {
    const status = googleRpcHttpStatusCode(parsed.error.code);
    return forwardHttp({ ...http, status, statusText: status === http.status ? http.statusText : '', body }, null);
  }
  const status = gatewayErrorStatus(http.status) === 'INTERNAL' ? 500 : http.status;
  return geminiJsonBody(http, geminiGenerateContentRpcErrorPayload(status, message || 'Upstream Gemini generateContent request failed.'), status);
};
