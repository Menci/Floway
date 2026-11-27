import { getHeader, setHeader, type HttpRequestFact, type HttpResponseFact, type HttpStreamError } from '@floway-dev/http';
import { secret, type Result } from '@floway-dev/pipeline';
import { isEventStreamMediaType, isJsonObject, type JsonObject } from '@floway-dev/protocols/common';
import { httpDialError, parseJsonBody, parseUpstreamResult, parseUpstreamStream, protocolErrorDebugFields, type FormatProtocolError, type ProtocolStreamDecoder } from '@floway-dev/upstream';

type Surface = 'openai' | 'anthropic';
interface SerializedBody {
  body: Uint8Array | string;
  contentType: string;
}

export const jsonBody = (payload: object): SerializedBody => ({ body: JSON.stringify(payload), contentType: 'application/json' });

// https://learn.microsoft.com/en-us/azure/foundry/openai/concepts/model-router-reference
export const azureRequest = (http: HttpRequestFact, url: string, apiKey: string, { body, contentType }: SerializedBody, surface: Surface = 'openai'): HttpRequestFact => {
  const credential = secret(apiKey);
  const authenticated = surface === 'openai'
    ? setHeader(http.headers, 'api-key', credential)
    : setHeader(setHeader(http.headers, 'x-api-key', credential), 'anthropic-version', '2023-06-01');
  return { ...http, url, method: 'POST', headers: setHeader(authenticated, 'content-type', contentType), body };
};

const invalidRequest = (status: number | null): boolean => status !== null && status >= 400 && status < 500;

export const openAIError: FormatProtocolError = (status, message, diagnostic) => ({
  error: { type: invalidRequest(status) ? 'invalid_request_error' : 'server_error', message, ...protocolErrorDebugFields(diagnostic) },
});

export const anthropicError: FormatProtocolError = (status, message, diagnostic) => ({
  type: 'error',
  error: { type: invalidRequest(status) ? 'invalid_request_error' : 'api_error', message, ...protocolErrorDebugFields(diagnostic) },
});

export const decodeJsonBody = <Output>(bytes: Uint8Array, decode: (body: unknown) => Result<Output, Error>): Result<Output, Error> => {
  const parsed = parseJsonBody(bytes);
  return parsed.ok ? decode(parsed.value) : parsed;
};

export const decodeJsonObject = (bytes: Uint8Array): Result<JsonObject, Error> =>
  decodeJsonBody(bytes, body => isJsonObject(body)
    ? { ok: true, value: body }
    : { ok: false, error: new Error('Expected a JSON object in the Azure response') });

export const MAX_AZURE_RESULT_BODY_BYTES = 16 * 1024 * 1024;
// Image results can contain a batch of base64-encoded images.
export const MAX_AZURE_IMAGE_RESULT_BODY_BYTES = 128 * 1024 * 1024;
export const MAX_AZURE_ERROR_BODY_BYTES = 1024 * 1024;

type ResultScope = Parameters<typeof parseUpstreamResult>[1];
type StreamScope = Parameters<typeof parseUpstreamStream>[1];
type ResultDecoder<Output> = Parameters<typeof parseUpstreamResult<Output>>[2];

const requireResponse = (http: HttpResponseFact | null): HttpResponseFact => {
  if (http === null) throw new Error('Azure dial completed without response headers or an HTTP error');
  return http;
};

export const parseAzureResult = async <Output>(
  http: HttpResponseFact | null,
  failure: HttpStreamError | undefined,
  scope: ResultScope,
  decode: ResultDecoder<Output>,
  format: FormatProtocolError = openAIError,
  maxResultBodyBytes = MAX_AZURE_RESULT_BODY_BYTES,
) => {
  if (failure !== undefined) return { http: null, outcome: httpDialError(failure, format) };
  return await parseUpstreamResult(requireResponse(http), scope, decode, format, { maxResultBodyBytes, maxErrorBodyBytes: MAX_AZURE_ERROR_BODY_BYTES });
};

export const parseAzureStream = async <Event>(
  http: HttpResponseFact | null,
  failure: HttpStreamError | undefined,
  scope: StreamScope,
  decode: ProtocolStreamDecoder<Event>,
  format: FormatProtocolError = openAIError,
) => {
  if (failure !== undefined) return { http: null, outcome: httpDialError(failure, format) };
  return await parseUpstreamStream(requireResponse(http), scope, decode, format, MAX_AZURE_ERROR_BODY_BYTES);
};

export const parseAzureStreamOrResult = async <Event, Output>(
  http: HttpResponseFact | null,
  failure: HttpStreamError | undefined,
  scope: StreamScope,
  decodeStream: ProtocolStreamDecoder<Event>,
  decodeResult: ResultDecoder<Output>,
  maxResultBodyBytes = MAX_AZURE_RESULT_BODY_BYTES,
) => {
  const mediaType = http === null ? undefined : getHeader(http.headers, 'content-type');
  return typeof mediaType === 'string' && isEventStreamMediaType(mediaType)
    ? await parseAzureStream(http, failure, scope, decodeStream)
    : await parseAzureResult(http, failure, scope, decodeResult, openAIError, maxResultBodyBytes);
};
