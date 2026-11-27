import type { HttpResponseFact } from '@floway-dev/http';
import type { Result } from '@floway-dev/pipeline';
import { httpDialError, parseJsonBody, parseUpstreamResult, parseUpstreamStream, protocolErrorDebugFields, type FormatProtocolError, type ProtocolError, type ProtocolStreamDecoder, type UpstreamHttpResponseFacts } from '@floway-dev/upstream';

export const ERROR_BODY_LIMIT = 1024 * 1024;
export const BODY_LIMITS = { maxResultBodyBytes: 32 * 1024 * 1024, maxErrorBodyBytes: ERROR_BODY_LIMIT };

const errorType = (status: number | null): string => status === null || status >= 500 ? 'api_error' : 'invalid_request_error';
export const formatOpenAIError: FormatProtocolError = (status, message, diagnostic) => ({
  error: { type: errorType(status), message, ...protocolErrorDebugFields(diagnostic) },
});
export const formatAnthropicError: FormatProtocolError = (status, message, diagnostic) => ({
  type: 'error',
  error: { type: errorType(status), message, ...protocolErrorDebugFields(diagnostic) },
});

type HttpAnswer = Omit<UpstreamHttpResponseFacts, 'http.error'> & Partial<Pick<UpstreamHttpResponseFacts, 'http.error'>>;
type BodyReader = Parameters<typeof parseUpstreamResult>[1];
type BodyProducer = Parameters<typeof parseUpstreamStream>[1];
type ResponseDecoder<Output> = Parameters<typeof parseUpstreamResult<Output>>[2];

export const decodeAnswer = async <Outcome>(
  answer: HttpAnswer,
  format: FormatProtocolError,
  decode: (http: HttpResponseFact) => Promise<{ http: HttpResponseFact; outcome: Outcome }>,
): Promise<{ http: HttpResponseFact | null; outcome: Outcome | ProtocolError }> => {
  const { 'http.error': failure, ...response } = answer;
  const { http } = response;
  if (failure !== undefined) {
    return { ...response, http: null, outcome: httpDialError(failure, format) };
  }
  if (http === null) throw new Error('Expected Ollama HTTP response headers or a dial error');
  return { ...response, ...await decode(http) };
};

export const decodeStream = <Event>(answer: HttpAnswer, scope: BodyProducer, format: FormatProtocolError, decode: ProtocolStreamDecoder<Event>) =>
  decodeAnswer(answer, format, http => parseUpstreamStream(http, scope, decode, format, ERROR_BODY_LIMIT));

export const decodeResult = <Output>(answer: HttpAnswer, scope: BodyReader, format: FormatProtocolError, decode: ResponseDecoder<Output>) =>
  decodeAnswer(answer, format, http => parseUpstreamResult(http, scope, decode, format, BODY_LIMITS));

export const decodeJson = <Output>(body: Uint8Array, decode: (json: unknown) => Result<Output, unknown>): Result<Output, unknown> => {
  const json = parseJsonBody(body);
  return json.ok ? decode(json.value) : json;
};
