import { ANTHROPIC_VERSION, parseCustomUpstreamConfig, type CustomAuthStyle, type CustomPathOverrideKey, type CustomUpstreamConfig } from '../config.ts';
import { customActionUrl, pathOverrideFor } from '../endpoints.ts';
import { filterHeaders, getHeaders, hasHeader, setHeader, type HttpHeaders, type HttpRequestFact, type HttpResponseFact } from '@floway-dev/http';
import { factSpace, secret, type Result } from '@floway-dev/pipeline';
import { isJsonObject, type JsonObject } from '@floway-dev/protocols/common';
import { geminiGenerateContentStatusForHttpStatus } from '@floway-dev/protocols/gemini-generate-content';
import { httpDialError, internalDebugErrorFields, joinBaseAndPath, parseJsonBody, parseUpstreamResult, parseUpstreamStream, protocolErrorDebugFields, type FormatProtocolError, type ProtocolStream, type ProtocolStreamDecoder, type UpstreamEvent, type UpstreamHttpResponseFacts, type UpstreamHttpServices, type UpstreamRequestFacts, type UpstreamResponseFacts, type UpstreamSnapshot } from '@floway-dev/upstream';

interface CustomHttpResponseFacts extends UpstreamHttpResponseFacts {
  'custom.openaiAudioTranscriptions.stream': ProtocolStream<UpstreamEvent<'openaiAudioTranscriptions'>>;
}

export const { defineStage, compose } = factSpace<UpstreamRequestFacts, UpstreamResponseFacts & CustomHttpResponseFacts, UpstreamHttpServices>();

export const dialResponseNeeds = ['http', 'http.error?'] as const;
export const dialResponseConsumes = ['http.error'] as const;

const MiB = 1024 * 1024;
export const HTTP_ERROR_BODY_BYTES = MiB;
export const COUNT_RESULT_BODY_BYTES = MiB;
export const TEXT_RESULT_BODY_BYTES = 16 * MiB;
export const EMBEDDINGS_RESULT_BODY_BYTES = 64 * MiB;
export const AUDIO_RESULT_BODY_BYTES = 64 * MiB;
export const IMAGE_RESULT_BODY_BYTES = 128 * MiB;

const formats: Record<CustomAuthStyle, FormatProtocolError> = {
  bearer: (status, message, diagnostic) => ({
    error: { type: clientStatus(status) ? 'invalid_request_error' : 'server_error', message, ...protocolErrorDebugFields(diagnostic) },
  }),
  'x-api-key': (status, message, diagnostic) => ({
    type: 'error',
    error: { type: clientStatus(status) ? 'invalid_request_error' : 'api_error', message, ...protocolErrorDebugFields(diagnostic) },
  }),
  'x-goog-api-key': (status, message, diagnostic) => {
    const code = status ?? 500;
    const symbolic = code === 499 ? 'CANCELLED' : geminiGenerateContentStatusForHttpStatus(code);
    const error = { code, message, ...(symbolic === undefined ? {} : { status: symbolic }) };
    if (diagnostic === undefined) return { error };
    const { stack, ...fields } = internalDebugErrorFields(diagnostic);
    // https://protobuf.dev/programming-guides/json/#any
    // https://github.com/googleapis/googleapis/blob/e09e85d32ca349e1b205514a412817a7692595c6/google/rpc/error_details.proto#L97-L104
    const details = [
      ...(stack === undefined ? [] : [{ '@type': 'type.googleapis.com/google.rpc.DebugInfo', stackEntries: stack.split('\n') }]),
      { '@type': 'type.googleapis.com/google.protobuf.Struct', value: { type: diagnostic.type, ...fields } },
    ];
    return { error: { ...error, details } };
  },
};

const clientStatus = (status: number | null): boolean => status !== null && status >= 400 && status < 500;

export const customConfig = (upstream: UpstreamSnapshot): CustomUpstreamConfig => {
  if (upstream.kind !== 'custom') throw new Error(`Expected custom upstream, got ${upstream.kind}`);
  return parseCustomUpstreamConfig(upstream.config);
};

// Anthropic ingress and translation own the beta list; rules control every
// other incoming header name.
// https://github.com/anthropics/anthropic-sdk-typescript/blob/3b45cd3b69c956ac63384fdb09ce1d8109f3fa80/src/resources/beta/beta.ts#L622-L635
export const customHeaders = (incoming: HttpHeaders, config: CustomUpstreamConfig, auth: CustomAuthStyle, contentType: string): HttpHeaders => {
  const headers = auth === 'x-api-key' ? filterHeaders(incoming, name => name === 'anthropic-beta') : [];
  for (const { key, value } of config.ingressHeadersRules) {
    if (value === null) {
      for (const admitted of getHeaders(incoming, key)) headers.push([key, admitted]);
    } else {
      headers.push([key, value]);
    }
  }
  if (config.apiKey !== '') {
    const apiKey = secret(config.apiKey);
    // https://developers.openai.com/api/reference/overview
    // https://ai.google.dev/gemini-api/docs/api-key
    if (auth === 'bearer') headers.push(['authorization', apiKey.map(value => `Bearer ${value}`)]);
    else headers.push([auth, apiKey]);
    if (auth === 'x-api-key' && !hasHeader(headers, 'anthropic-version')) headers.push(['anthropic-version', ANTHROPIC_VERSION]);
  }
  return setHeader(headers, 'content-type', contentType);
};

export const customRequest = (
  request: HttpRequestFact,
  config: CustomUpstreamConfig,
  endpoint: string | URL,
  content: { body: string | Uint8Array; contentType: string },
  auth: CustomAuthStyle = 'bearer',
): HttpRequestFact => ({
  ...request,
  url: typeof endpoint === 'string' ? joinBaseAndPath(config.baseUrl, endpoint) : endpoint.href,
  method: 'POST',
  headers: customHeaders(request.headers, config, auth, content.contentType),
  body: content.body,
});

export const customJsonRequest = (
  request: HttpRequestFact,
  config: CustomUpstreamConfig,
  endpoint: string | URL,
  payload: object,
  auth: CustomAuthStyle = 'bearer',
): HttpRequestFact => customRequest(request, config, endpoint, { body: JSON.stringify(payload), contentType: 'application/json' }, auth);

export const customModelRequest = (
  request: HttpRequestFact,
  upstream: UpstreamSnapshot,
  endpoint: CustomPathOverrideKey,
  model: string,
  payload: object,
  auth: CustomAuthStyle = 'bearer',
  suffix = '',
): HttpRequestFact => {
  const config = customConfig(upstream);
  const path = pathOverrideFor(config, endpoint);
  const target = suffix === '' ? path : customActionUrl(config, path, suffix);
  return customJsonRequest(request, config, target, { ...payload, model }, auth);
};

type DialAnswer = Pick<UpstreamHttpResponseFacts, 'http'> & Partial<Pick<UpstreamHttpResponseFacts, 'http.error'>>;
type BodyHead = Omit<HttpResponseFact, 'body'> & { body: null };
export type ResultDecoder<Output> = (bytes: Uint8Array, http: BodyHead) => Result<Output, unknown>;

export const nullableCountResult = <Output>(decode: ResultDecoder<Output>): ResultDecoder<Output | null> => (bytes, http) =>
  http.status === 204 || http.status === 205 ? { ok: true, value: null } : decode(bytes, http);

const responseOrError = ({ 'http.error': failure, ...answer }: DialAnswer, auth: CustomAuthStyle) => {
  if (failure !== undefined) return { ok: false, error: httpDialError(failure, formats[auth]) } as const;
  if (answer.http === null) throw new Error('Expected HTTP response headers or a dial error');
  return { ok: true, http: answer.http } as const;
};

export const customResult = async <Output>(
  answer: DialAnswer,
  scope: Parameters<typeof parseUpstreamResult>[1],
  decode: ResultDecoder<Output>,
  maxResultBodyBytes: number,
  auth: CustomAuthStyle = 'bearer',
) => {
  const settled = responseOrError(answer, auth);
  if (!settled.ok) return { http: null, outcome: settled.error };
  return await parseUpstreamResult(settled.http, scope, decode, formats[auth], { maxResultBodyBytes, maxErrorBodyBytes: HTTP_ERROR_BODY_BYTES });
};

export const customStream = async <Event>(
  answer: DialAnswer,
  scope: Parameters<typeof parseUpstreamStream>[1],
  decode: ProtocolStreamDecoder<Event>,
  auth: CustomAuthStyle = 'bearer',
) => {
  const settled = responseOrError(answer, auth);
  if (!settled.ok) return { http: null, outcome: settled.error };
  return await parseUpstreamStream(settled.http, scope, decode, formats[auth], HTTP_ERROR_BODY_BYTES);
};

export const decodeJson = <Output>(decode: (value: unknown) => Result<Output, unknown>): ResultDecoder<Output> => bytes => {
  const parsed = parseJsonBody(bytes);
  return parsed.ok ? decode(parsed.value) : parsed;
};

export const decodeJsonObject = decodeJson((value): Result<JsonObject, Error> => isJsonObject(value)
  ? { ok: true, value }
  : { ok: false, error: new Error('Expected a JSON object in upstream response') });

export const keepBytes: ResultDecoder<Uint8Array> = bytes => ({ ok: true, value: bytes });
