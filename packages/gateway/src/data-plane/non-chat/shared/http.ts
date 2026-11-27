import type { GatewayServices } from '../../pipeline/services.ts';
import { isForwardableUpstreamHeader } from '../../shared/upstream-response.ts';
import { filterHeaders, getHeader, setHeader, type HttpRequestFact, type HttpResponseFact, type HttpStreamError } from '@floway-dev/http';
import type { ManagedStream, Result } from '@floway-dev/pipeline';
import { eventFrame, isJsonMediaType, isJsonObject, isMultipartFormDataMediaType, parseJSONWithRawNumbers, type JsonObject, type MultipartFile, type ProtocolFrame } from '@floway-dev/protocols/common';
import { internalDebugErrorFields, toInternalDebugError, type ProtocolError, type ProtocolStreamError } from '@floway-dev/upstream';

const utf8 = new TextEncoder();
const decoder = new TextDecoder();

export const openAIError = (message: string) => ({ error: { message, type: 'api_error' } });

export const localHead = (status: number): HttpResponseFact => ({ status, statusText: '', headers: [], body: null });

export const encodedResponse = (
  http: HttpResponseFact,
  body: HttpResponseFact['body'],
  contentType?: string,
): HttpResponseFact => {
  const headers = filterHeaders(http.headers, name => name === 'content-type' || isForwardableUpstreamHeader(name));
  return {
    ...http,
    headers: contentType === undefined ? headers : setHeader(headers, 'content-type', contentType),
    body: http.status === 204 || http.status === 205 || http.status === 304 ? null : body,
  };
};

export const jsonResponse = (http: HttpResponseFact, value: unknown): HttpResponseFact => {
  const contentType = getHeader(http.headers, 'content-type');
  return encodedResponse(
    http,
    utf8.encode(JSON.stringify(value)),
    typeof contentType === 'string' && isJsonMediaType(contentType) ? undefined : 'application/json',
  );
};

export const errorResponse = (http: HttpResponseFact | null, outcome: ProtocolError): HttpResponseFact => {
  if (http === null) return jsonResponse(localHead(outcome.source === 'upstream' ? 502 : 499), outcome.error);
  if (outcome.source === 'upstream' && http.status >= 200 && http.status < 300) {
    return jsonResponse({ ...http, status: 502, statusText: '' }, outcome.error);
  }
  if (outcome.source === 'local' && http.status >= 200 && http.status < 300) {
    return jsonResponse({ ...http, status: 499, statusText: '' }, outcome.error);
  }
  return jsonResponse(http, outcome.error);
};

export const decodeRequestBody = (http: HttpRequestFact): string => {
  if (http.body === null) return '';
  if (typeof http.body === 'string') return http.body;
  if (!(http.body instanceof Uint8Array)) throw new TypeError('An encoded request must carry bytes');
  return decoder.decode(http.body);
};

export const readJson = (http: HttpRequestFact, invalid: string): Result<unknown, string> => {
  try {
    return { ok: true, value: parseJSONWithRawNumbers(decodeRequestBody(http)) };
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    return { ok: false, error: invalid };
  }
};

export const readJsonModel = (http: HttpRequestFact, name: string): Result<{ model: string; body: JsonObject }, string> => {
  const parsed = readJson(http, `${name} request body must be valid JSON.`);
  if (!parsed.ok) return parsed;
  const body = parsed.value;
  if (!isJsonObject(body)) return { ok: false, error: `${name} request body must be an object.` };
  if (typeof body.model !== 'string' || body.model.length === 0) {
    return { ok: false, error: `${name} request body must include a model string.` };
  }
  return { ok: true, value: { model: body.model, body } };
};

export const readMultipart = async (http: HttpRequestFact, name: string): Promise<Result<FormData, string>> => {
  const contentType = getHeader(http.headers, 'content-type');
  if (typeof contentType !== 'string' || !isMultipartFormDataMediaType(contentType)) {
    return { ok: false, error: `${name} request body must use multipart/form-data.` };
  }
  const { body: bytes } = http;
  if (bytes !== null && !(bytes instanceof Uint8Array)) throw new TypeError('A multipart request must carry bytes');
  const body = bytes === null ? null : bytes.buffer instanceof ArrayBuffer
    ? new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    : new Uint8Array(bytes);
  try {
    return { ok: true, value: await new Response(body, { headers: { 'content-type': contentType } }).formData() };
  } catch (error) {
    if (!(error instanceof TypeError)) throw error;
    return { ok: false, error: `${name} request body must be valid multipart/form-data.` };
  }
};

export const multipartFile = async (file: File): Promise<MultipartFile> => ({
  name: file.name,
  mediaType: file.type,
  bytes: new Uint8Array(await file.arrayBuffer()),
});

type ProtocolStream<Event> = ManagedStream<Event, ProtocolStreamError>;
type ByteStream = ManagedStream<Uint8Array, HttpStreamError>;

interface SseProducer<Event> {
  read(source: ProtocolStream<Event>): AsyncIterableIterator<Result<Event, ProtocolStreamError>>;
  discard(source: ProtocolStream<Event>): void;
  services: Pick<GatewayServices, 'dump'>;
}

interface SseScope<Event> {
  wrapStream(
    stream: ProtocolStream<Event>,
    encode: (stream: ProtocolStream<Event>, producer: SseProducer<Event>) => AsyncGenerator<Result<Uint8Array, HttpStreamError>, void, unknown>,
  ): ByteStream;
}

const encodeFrame = (frame: ProtocolFrame<unknown>, eventName?: string): Uint8Array => {
  if (eventName !== undefined && /[\r\n]/.test(eventName)) throw new Error('SSE event name cannot contain CR or LF');
  const prefix = eventName ? `event: ${eventName}\n` : '';
  const data = frame.type === 'done' ? '[DONE]' : JSON.stringify(frame.event);
  return utf8.encode(`${prefix}data: ${data}\n\n`);
};

export const encodeSse = <Event>(
  stream: ProtocolStream<Event>,
  scope: SseScope<Event>,
  render: (event: Event) => ProtocolFrame<unknown> | null,
  onDone?: () => ProtocolFrame<unknown> | null,
  eventName?: (event: Event) => string | undefined,
): ByteStream => scope.wrapStream(stream, async function* (source, producer) {
  const record = (frame: ProtocolFrame<unknown>, name?: string): Result<Uint8Array, HttpStreamError> => {
    producer.services.dump?.frame(frame);
    return { ok: true, value: encodeFrame(frame, name) };
  };
  for await (const item of producer.read(source)) {
    if (item.ok) {
      const frame = render(item.value);
      if (frame !== null) yield record(frame, eventName?.(item.value));
      continue;
    }

    producer.discard(source);
    if (item.error.kind === 'abort') {
      yield { ok: false, error: item.error };
      return;
    }
    if (item.error.kind === 'protocol' && item.error.event !== undefined) {
      yield record(eventFrame(item.error.event), item.error.eventName);
      return;
    }
    const error = toInternalDebugError(item.error.cause);
    yield record(eventFrame({
      error: { type: error.type, message: error.message, provider_specific_fields: internalDebugErrorFields(error) },
    }));
    return;
  }
  const terminal = onDone?.();
  if (terminal != null) yield record(terminal);
});
