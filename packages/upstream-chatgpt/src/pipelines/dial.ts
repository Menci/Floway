import { hasChatGPTQuotaReading, parseChatGPTQuotaHeaders } from '../quota.ts';
import type { ChatGPTAccessError, ChatGPTAuthorization, ChatGPTServices, ChatGPTUnauthorized } from '../service.ts';
import { parseUpstreamError } from '../wire.ts';
import { setHeader, type HttpRequestFact, type HttpResponseFact, type HttpStreamError } from '@floway-dev/http';
import type { Facts, ManagedStream, Result } from '@floway-dev/pipeline';
import { isJsonObject, type JsonObject } from '@floway-dev/protocols/common';
import { httpDialError, parseJsonBody, protocolErrorDebugFields, type FormatProtocolError, type ProtocolError, type UpstreamSnapshot } from '@floway-dev/upstream';

export const HTTP_ERROR_BODY_BYTES = 1024 * 1024;
export const IMAGE_RESULT_BODY_BYTES = 128 * 1024 * 1024;
export const dialResponseNeeds = ['http', 'http.error?'] as const;
export const dialResponseConsumes = ['http.error'] as const;

export const formatError: FormatProtocolError = (_status, message, diagnostic) => ({
  error: { type: 'api_error', message, ...protocolErrorDebugFields(diagnostic) },
});

type HttpAnswer = { http: HttpResponseFact | null; 'http.error'?: HttpStreamError };
type HttpByteStream = ManagedStream<Uint8Array, HttpStreamError>;

interface DialScope {
  readonly services: Readonly<ChatGPTServices>;
  readonly signal: AbortSignal;
  readonly read: (stream: HttpByteStream) => AsyncIterableIterator<Result<Uint8Array, HttpStreamError>>;
  readonly discard: (item: HttpByteStream | Facts) => void;
  readonly abort: (promise: Promise<unknown>) => void;
  readonly detach: (work: (scope: { log: { withError(cause: unknown): { warn(message: string): void } }; services: Readonly<ChatGPTServices> }) => Promise<unknown>) => void;
}

interface DialOptions<Prepared, Answer> {
  upstream: UpstreamSnapshot;
  images?: boolean;
  prepare(installationId: string): Prepared | Promise<Prepared>;
  next(prepared: Prepared, request: HttpRequestFact): Promise<Answer>;
}

const localFailure = ({ status, type, message }: ChatGPTAccessError) => ({
  kind: 'error' as const,
  http: { status, statusText: '', headers: [['content-type', 'application/json']], body: null } satisfies HttpResponseFact,
  outcome: { kind: 'error', source: 'local', error: { error: { type, message } } } satisfies ProtocolError,
});

export const dialChatGPT = async <Prepared extends { request: HttpRequestFact }, Answer extends HttpAnswer>(
  scope: DialScope,
  { upstream, images = false, prepare, next }: DialOptions<Prepared, Answer>,
) => {
  if (scope.signal.aborted) {
    return { kind: 'error' as const, http: null, outcome: httpDialError({ kind: 'abort', cause: scope.signal.reason }, formatError) };
  }
  let authorization: ChatGPTAuthorization = await scope.services.chatgpt.authorize(upstream, scope.services.fetcher(upstream.id), images);
  if (authorization.kind === 'unavailable') return localFailure(authorization.error);
  const prepared = await prepare(authorization.installationId);
  let retried = false;
  while (true) {
    const { accountId, bearer } = authorization;
    let headers = setHeader(prepared.request.headers, 'authorization', bearer);
    if (accountId !== null) headers = setHeader(headers, 'chatgpt-account-id', accountId);
    const child = next(prepared, { ...prepared.request, headers });
    const answer = await child;
    const { 'http.error': failure, http } = answer;
    if (failure !== undefined) return { kind: 'error' as const, http: null, outcome: httpDialError(failure, formatError) };
    if (http === null) throw new Error('Expected ChatGPT HTTP response headers or a dial error');

    if ((http.status >= 200 && http.status < 300) || http.status === 429) observeQuota(http, scope, upstream, images);
    if (http.status !== 401) return { kind: 'response' as const, answer, http };

    const bytes = await readUnauthorized(http.body, scope);
    if (!bytes.ok) return { kind: 'error' as const, http: { ...http, body: null }, outcome: httpDialError(bytes.error, formatError) };
    const replay = () => ({ kind: 'response' as const, answer, http: { ...http, body: bytes.value } });
    const rejected: ChatGPTUnauthorized = authorization.reject(parseUpstreamError(new TextDecoder().decode(bytes.value)));
    if (rejected.kind === 'access-only') {
      scope.detach(async ({ log }) => {
        try {
          await rejected.persist();
        } catch (cause) {
          log.withError(cause).warn('Failed to persist ChatGPT credential termination');
          throw cause;
        }
      });
      return replay();
    }
    if (rejected.kind === 'terminated') {
      scope.abort(child);
      scope.discard(answer);
      await rejected.persist();
      return localFailure(rejected.error);
    }
    if (retried || scope.signal.aborted) return replay();

    scope.abort(child);
    scope.discard(answer);
    authorization = await rejected.refresh();
    if (authorization.kind === 'unavailable') return localFailure(authorization.error);
    retried = true;
  }
};

const observeQuota = (http: HttpResponseFact, scope: DialScope, upstream: UpstreamSnapshot, images: boolean): void => {
  const headers = new Headers();
  for (const [name, value] of http.headers) {
    if (typeof value === 'string') headers.append(name, value);
  }
  const snapshot = parseChatGPTQuotaHeaders(headers, { now: new Date(), isRateLimited: http.status === 429 });
  if (images && !hasChatGPTQuotaReading(snapshot)) return;
  scope.detach(async ({ services, log }) => {
    try {
      await services.chatgpt.observeQuota(upstream, snapshot);
    } catch (cause) {
      log.withError(cause).warn('Failed to persist ChatGPT quota');
      throw cause;
    }
  });
};

const readUnauthorized = async (
  body: HttpResponseFact['body'], scope: DialScope,
): Promise<Result<Uint8Array, HttpStreamError>> => {
  if (body === null) return { ok: true, value: new Uint8Array() };
  if (body instanceof Uint8Array) {
    if (body.length > HTTP_ERROR_BODY_BYTES) throw new RangeError('ChatGPT 401 response exceeds 1 MiB');
    return { ok: true, value: body };
  }
  const chunks: Uint8Array[] = [];
  let length = 0;
  const cursor = scope.read(body);
  while (true) {
    const read = await cursor.next();
    if (read.done) break;
    const item = read.value;
    if (!item.ok) {
      scope.discard(body);
      return item;
    }
    if (item.value.length > HTTP_ERROR_BODY_BYTES - length) throw new RangeError('ChatGPT 401 response exceeds 1 MiB');
    if (item.value.length === 0) continue;
    chunks.push(item.value);
    length += item.value.length;
  }
  if (chunks.length === 1) return { ok: true, value: chunks[0]! };
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return { ok: true, value: bytes };
};

export const parseObject = (bytes: Uint8Array): Result<JsonObject, Error> => {
  const parsed = parseJsonBody(bytes);
  if (!parsed.ok) return parsed;
  return isJsonObject(parsed.value)
    ? { ok: true, value: parsed.value }
    : { ok: false, error: new TypeError('Expected a ChatGPT JSON response object') };
};
