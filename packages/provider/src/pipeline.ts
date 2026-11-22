import type { FlagId } from './flags.ts';
import { base64ToBytes, bytesToBase64, parseBase64ImageDataUrl } from './image-helpers.ts';
import { joinBaseAndPath } from './join.ts';
import { frozenJsonRequestBody } from './json-request.ts';
import type { ProviderModel, UpstreamProviderKind } from './model.ts';
import type { Fetcher, FetchInit } from './options.ts';
import { isSecret, secret, terminal } from '@floway-dev/pipeline';
import type {
  Ending,
  HeaderEntry,
  ManagedStream,
  Pipeline,
  Secret,
  StageEnv,
  WireHttpUrl,
  WireRequestSnapshot,
} from '@floway-dev/pipeline';
import type { AnthropicMessagesPayload, AnthropicMessagesStreamEventEx } from '@floway-dev/protocols/anthropic-messages';
import { isEventStreamMediaType } from '@floway-dev/protocols/common';
import type { AliasRules, DecisionTarget, ProtocolFrame, RerankTarget } from '@floway-dev/protocols/common';
import type { CanonicalDecisionRequest } from '@floway-dev/protocols/decision';
import type { GeminiGenerateContentPayload, GeminiGenerateContentStreamEvent } from '@floway-dev/protocols/gemini-generate-content';
import type { OpenAIChatCompletionsPayloadEx, OpenAIChatCompletionsStreamEvent } from '@floway-dev/protocols/openai-chat-completions';
import type { OpenAICompletionsPayload } from '@floway-dev/protocols/openai-completions';
import type { OpenAIEmbeddingsPayload } from '@floway-dev/protocols/openai-embeddings';
import type { OpenAIImageEditReference, OpenAIImagesGenerationsPayload } from '@floway-dev/protocols/openai-images';
import type { CanonicalOpenAIResponsesPayload, OpenAIResponsesCompactionResultEx, OpenAIResponsesStreamEventEx } from '@floway-dev/protocols/openai-responses';
import type { CanonicalRerankRequest } from '@floway-dev/protocols/rerank';

export type { Fetcher, FetchInit } from './options.ts';

export type ChatTargetApi = 'anthropicMessages' | 'geminiGenerateContent' | 'openaiResponses' | 'openaiChatCompletions';

export type OpenAIResponsesAction = 'generate' | 'compact';

export type ProviderStreamParser<TEvent> = (
  body: ReadableStream<Uint8Array>,
  options?: { signal?: AbortSignal },
) => AsyncIterable<ProtocolFrame<TEvent>>;

export const SENSITIVE_HTTP_HEADER_NAMES: ReadonlySet<string> = new Set([
  'authorization',
  'proxy-authorization',
  'x-api-key',
  'api-key',
  'cookie',
  'set-cookie',
  'www-authenticate',
  'proxy-authenticate',
]);

export const isSensitiveHttpHeaderName = (name: string): boolean =>
  SENSITIVE_HTTP_HEADER_NAMES.has(name.toLowerCase());

export const wrapSensitiveHeaderEntries = (
  entries: Iterable<readonly [string, string | Secret<string>]>,
): readonly HeaderEntry[] => Object.freeze([...entries].map(([name, value]) => Object.freeze([
  name,
  typeof value === 'string' && isSensitiveHttpHeaderName(name) ? secret(value) : value,
] as const)));

export const materializeWireUrl = (url: WireHttpUrl | string): string => {
  if (typeof url === 'string') return url;
  const query = url.query?.map(([name, value]) => {
    const raw = isSecret(value) ? value.reveal() : value;
    return `${encodeURIComponent(name)}=${encodeURIComponent(raw)}`;
  });
  return `${url.origin}${url.pathname}${query === undefined || query.length === 0 ? '' : `?${query.join('&')}`}`;
};

export const materializeHeaderLines = (headers: readonly HeaderEntry[]): [string, string][] =>
  headers.map(([name, value]) => [name, isSecret(value) ? value.reveal() : value]);

export type MultipartField =
  | { readonly kind: 'text'; readonly name: string; readonly value: string }
  | {
    readonly kind: 'file';
    readonly name: string;
    readonly bytes: Uint8Array;
    readonly filename: string;
    readonly contentType: string;
  };

export type ImageEditPartSource =
  | {
    readonly type: 'upload';
    readonly bytes: Uint8Array;
    readonly filename: string;
    readonly contentType: string;
  }
  | { readonly type: 'inline'; readonly reference: OpenAIImageEditReference & { image_url: string } }
  | { readonly type: 'reference'; readonly reference: OpenAIImageEditReference };

export interface ImageEditsPipelineRequest {
  readonly images: readonly ImageEditPartSource[];
  readonly mask?: ImageEditPartSource;
  readonly parameters: Readonly<Record<string, unknown>>;
}

export interface AudioTranscriptionPipelineRequest {
  readonly entries: readonly MultipartField[];
}

export type HttpRequestBody =
  | Uint8Array
  | string
  | { readonly kind: 'json'; readonly value: object }
  | { readonly kind: 'multipart'; readonly parts: readonly MultipartField[]; readonly boundary?: string }
  | { readonly kind: 'raw'; readonly bytes: Uint8Array; readonly contentType?: string }
  | null
  | undefined;

// RFC 7578 §2 / WHATWG HTML multipart/form-data escaping for field & file names.
const escapeMultipartQuoted = (value: string): string =>
  value.replaceAll('\r', '%0D').replaceAll('\n', '%0A').replaceAll('"', '%22');

const createMultipartBoundary = (): string => `----FlowayFormBoundary${crypto.randomUUID().replaceAll('-', '')}`;

export const encodeMultipartFormData = (
  parts: readonly MultipartField[],
  boundary = createMultipartBoundary(),
): { readonly bytes: Uint8Array; readonly contentType: string } => {
  const encoder = new TextEncoder();
  const chunks: Uint8Array[] = [];
  const crlf = encoder.encode('\r\n');
  for (const part of parts) {
    if (part.kind === 'text') {
      chunks.push(
        encoder.encode(
          `--${boundary}\r\nContent-Disposition: form-data; name="${escapeMultipartQuoted(part.name)}"\r\n\r\n${part.value}\r\n`,
        ),
      );
    } else {
      const mime = part.contentType || 'application/octet-stream';
      chunks.push(
        encoder.encode(
          `--${boundary}\r\nContent-Disposition: form-data; name="${escapeMultipartQuoted(part.name)}"; filename="${escapeMultipartQuoted(part.filename)}"\r\nContent-Type: ${mime}\r\n\r\n`,
        ),
        part.bytes,
        crlf,
      );
    }
  }
  chunks.push(encoder.encode(`--${boundary}--\r\n`));
  let total = 0;
  for (const chunk of chunks) total += chunk.byteLength;
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return {
    bytes,
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
};

export const buildWireHttpUrl = (
  baseUrl: string,
  pathSuffix: string,
  extraQuery?: ReadonlyArray<readonly [string, string | Secret<string>]>,
): WireHttpUrl => {
  const baseParsed = new URL(baseUrl);
  const query: Array<readonly [string, string | Secret<string>]> = [];
  for (const [key, val] of baseParsed.searchParams.entries()) {
    query.push(Object.freeze([key, secret(val)] as const));
  }
  const cleanBase = `${baseParsed.origin}${baseParsed.pathname.replace(/\/+$/, '')}`;
  const joined = new URL(joinBaseAndPath(cleanBase, pathSuffix));
  for (const [key, val] of joined.searchParams.entries()) {
    query.push(Object.freeze([key, secret(val)] as const));
  }
  if (extraQuery) {
    for (const [key, val] of extraQuery) query.push(Object.freeze([key, val] as const));
  }
  return Object.freeze({
    origin: joined.origin,
    pathname: joined.pathname,
    ...(query.length > 0 ? { query: Object.freeze(query) } : {}),
  });
};

const toUploadedPart = (
  source: ImageEditPartSource,
  fieldName: string,
  index: number,
): Extract<MultipartField, { kind: 'file' }> | null => {
  if (source.type === 'upload') {
    return {
      kind: 'file',
      name: fieldName,
      bytes: source.bytes,
      filename: source.filename,
      contentType: source.contentType,
    };
  }
  if (source.type === 'reference') return null;
  const parsed = parseBase64ImageDataUrl(source.reference.image_url);
  if (parsed === null) return null;
  let bytes: Uint8Array;
  try {
    bytes = base64ToBytes(parsed.base64);
  } catch {
    return null;
  }
  return {
    kind: 'file',
    name: fieldName,
    bytes,
    filename: `image-${index}`,
    contentType: parsed.mimeType,
  };
};

const toImageJsonRef = (source: ImageEditPartSource): OpenAIImageEditReference => {
  if (source.type === 'inline' || source.type === 'reference') return source.reference;
  return { image_url: `data:${source.contentType || 'application/octet-stream'};base64,${bytesToBase64(source.bytes)}` };
};

export const buildImagesEditsJsonPayload = (
  request: ImageEditsPipelineRequest,
  model: string,
): Record<string, unknown> => ({
  ...request.parameters,
  images: request.images.map(toImageJsonRef),
  ...(request.mask === undefined ? {} : { mask: toImageJsonRef(request.mask) }),
  model,
});

export const buildImagesEditsHttpBody = (
  request: ImageEditsPipelineRequest,
  model: string,
): HttpRequestBody => {
  const allSources = [...request.images, ...(request.mask === undefined ? [] : [request.mask])];
  const compatibleSources = allSources.every(
    source => source.type === 'upload'
      || (source.type === 'inline' && Object.keys(source.reference).every(key => key === 'image_url')),
  );
  const compatibleParams = Object.values(request.parameters).every(
    val => typeof val === 'string' || typeof val === 'number' || typeof val === 'boolean',
  );
  if (compatibleSources && compatibleParams) {
    const imageField = request.images.length === 1 ? 'image' : 'image[]';
    const fileParts: MultipartField[] = [];
    let ok = true;
    for (let i = 0; i < request.images.length; i++) {
      const part = toUploadedPart(request.images[i]!, imageField, i);
      if (part === null) {
        ok = false;
        break;
      }
      fileParts.push(part);
    }
    if (ok && request.mask !== undefined) {
      const maskPart = toUploadedPart(request.mask, 'mask', request.images.length);
      if (maskPart === null) ok = false;
      else fileParts.push(maskPart);
    }
    if (ok) {
      const parts: MultipartField[] = [
        ...Object.entries(request.parameters).map(([name, val]): MultipartField => ({
          kind: 'text',
          name,
          value: String(val),
        })),
        ...fileParts,
        { kind: 'text', name: 'model', value: model },
      ];
      return { kind: 'multipart', parts };
    }
  }
  return { kind: 'json', value: buildImagesEditsJsonPayload(request, model) };
};

export const buildAudioTranscriptionMultipartBody = (
  request: AudioTranscriptionPipelineRequest,
  modelField: { readonly type: 'replace'; readonly value: string } | { readonly type: 'omit' },
): HttpRequestBody => {
  const parts: MultipartField[] = [];
  for (const entry of request.entries) {
    if (entry.name === 'model') {
      if (modelField.type === 'replace') {
        parts.push({ kind: 'text', name: 'model', value: modelField.value });
      }
    } else {
      parts.push(entry);
    }
  }
  return { kind: 'multipart', parts };
};

export interface UpstreamHttpRequest extends Omit<WireRequestSnapshot, 'body'> {
  readonly method: string;
  readonly url: WireHttpUrl | string;
  readonly headers: readonly HeaderEntry[];
  readonly body?: HttpRequestBody;
}

const withoutHeader = (headers: readonly HeaderEntry[], name: string): readonly HeaderEntry[] => Object.freeze(
  headers.filter(([headerName]) => headerName.toLowerCase() !== name),
);

const withContentType = (
  entries: readonly HeaderEntry[],
  contentType: string,
): readonly HeaderEntry[] => Object.freeze([
  ...entries,
  Object.freeze(['content-type', contentType] as const),
]);

export const prepareUpstreamHttpRequest = (request: UpstreamHttpRequest): UpstreamHttpRequest => {
  const body = request.body;
  if (body === null || body === undefined || body instanceof Uint8Array || typeof body === 'string') return request;
  if (body.kind === 'json') {
    return hasHeader(request.headers, 'content-type')
      ? request
      : { ...request, headers: withContentType(request.headers, 'application/json') };
  }
  if (body.kind === 'raw') {
    return body.contentType === undefined || hasHeader(request.headers, 'content-type')
      ? request
      : { ...request, headers: withContentType(request.headers, body.contentType) };
  }
  const boundary = body.boundary ?? createMultipartBoundary();
  return {
    ...request,
    headers: withContentType(withoutHeader(request.headers, 'content-type'), `multipart/form-data; boundary=${boundary}`),
    body: { ...body, boundary },
  };
};

export interface HttpOutcome {
  readonly status: number;
  readonly statusText: string;
  readonly headers: readonly HeaderEntry[];
  readonly body: ManagedStream<Uint8Array> | null;
  readonly modelKey?: string;
  readonly timing: {
    readonly startedAtMs: number;
    readonly headersAtMs: number;
  };
}

export interface ProviderPipelineServices {
  readonly fetcherFor: (upstreamId: string) => Fetcher;
  readonly onUpstreamDispatch?: (info: {
    readonly upstreamId: string;
    readonly startedAtMs: number;
    readonly headersAtMs?: number;
  }) => void;
}

const hasHeader = (headers: readonly HeaderEntry[], name: string): boolean =>
  headers.some(([headerName]) => headerName.toLowerCase() === name);

interface MaterializedRequestBody {
  readonly body?: FetchInit['body'];
  readonly headers: readonly HeaderEntry[];
}

const materializeRequestBody = (body: HttpRequestBody, headers: readonly HeaderEntry[]): MaterializedRequestBody => {
  if (body === null || body === undefined) return { headers };
  if (body instanceof Uint8Array) return { body: body as Uint8Array<ArrayBuffer>, headers };
  if (typeof body === 'string') return { body, headers };
  if (body.kind === 'multipart') {
    const encoded = encodeMultipartFormData(body.parts, body.boundary);
    return {
      body: encoded.bytes as Uint8Array<ArrayBuffer>,
      headers,
    };
  }
  if (body.kind === 'raw') {
    return { body: body.bytes as Uint8Array<ArrayBuffer>, headers };
  }
  return { body: frozenJsonRequestBody(body.value), headers };
};

const responseHeaderEntries = (response: Response): readonly HeaderEntry[] => {
  const headerEntries = [...response.headers.entries()];
  const getSetCookie = (response.headers as Headers & { getSetCookie?: () => string[] }).getSetCookie;
  if (getSetCookie !== undefined) {
    const setCookies = getSetCookie.call(response.headers);
    if (setCookies.length > 0) {
      let inserted = false;
      const withSetCookies: Array<readonly [string, string]> = [];
      for (const entry of headerEntries) {
        if (entry[0].toLowerCase() !== 'set-cookie') {
          withSetCookies.push(entry);
        } else if (!inserted) {
          withSetCookies.push(...setCookies.map(value => ['set-cookie', value] as const));
          inserted = true;
        }
      }
      if (!inserted) withSetCookies.push(...setCookies.map(value => ['set-cookie', value] as const));
      return wrapSensitiveHeaderEntries(withSetCookies);
    }
  }
  return wrapSensitiveHeaderEntries(headerEntries);
};

const NO_BODY_STATUSES = new Set([204, 205, 304]);

const createResponseBody = async (
  response: Response,
  env: StageEnv<ProviderPipelineServices>,
  requestControl: { readonly abort: (reason?: unknown) => void; readonly detach: () => void },
): Promise<ManagedStream<Uint8Array> | null> => {
  if (response.body === null || NO_BODY_STATUSES.has(response.status)) {
    requestControl.detach();
    if (response.body !== null) await response.body.cancel();
    return null;
  }
  const reader = response.body.getReader();
  let exhausted = false;
  let released = false;
  let detachAbort = (): void => undefined;
  const release = (): void => {
    if (released) return;
    released = true;
    detachAbort();
    requestControl.detach();
    reader.releaseLock();
  };
  return env.createStream<Uint8Array>({
    label: 'http.body',
    async *iterate(signal) {
      const abort = (): void => {
        requestControl.abort(signal.reason);
        void reader.cancel(signal.reason).catch(() => undefined);
      };
      if (signal.aborted) abort();
      else signal.addEventListener('abort', abort, { once: true });
      detachAbort = () => signal.removeEventListener('abort', abort);
      try {
        for (;;) {
          const next = await reader.read();
          if (next.done) {
            exhausted = true;
            return;
          }
          yield next.value;
        }
      } finally {
        release();
      }
    },
    onClose: async ({ how, reason }) => {
      try {
        if (how !== 'exhausted' && !exhausted) requestControl.abort(reason);
        if (!exhausted && !released) await reader.cancel(reason);
      } finally {
        release();
      }
    },
  });
};

export const httpTerminal = (
  upstreamId: string,
  name = `${upstreamId}.http`,
): Ending<
  { readonly 'request.http': UpstreamHttpRequest; readonly 'provider.modelKey'?: string },
  HttpOutcome,
  ProviderPipelineServices
> => terminal({
  name,
  tap: 'upstream',
  prepare: facts => ({
    ...facts,
    'request.http': prepareUpstreamHttpRequest(facts['request.http']),
  }),
  execute: async (facts, env) => {
    const request = facts['request.http'];
    const url = materializeWireUrl(request.url);
    const materialized = materializeRequestBody(request.body, request.headers);
    const requestAbort = new AbortController();
    const forwardAbort = (): void => requestAbort.abort(env.signal.reason);
    if (env.signal.aborted) forwardAbort();
    else env.signal.addEventListener('abort', forwardAbort, { once: true });
    const detachParentAbort = (): void => env.signal.removeEventListener('abort', forwardAbort);
    const startedAtMs = env.clock();
    env.onUpstreamDispatch?.({ upstreamId, startedAtMs });
    let response: Response;
    try {
      response = await env.fetcherFor(upstreamId)(url, {
        method: request.method,
        headers: materializeHeaderLines(materialized.headers),
        ...(materialized.body === undefined ? {} : { body: materialized.body }),
        signal: requestAbort.signal,
      });
    } catch (error) {
      detachParentAbort();
      throw error;
    }
    const headersAtMs = env.clock();
    env.onUpstreamDispatch?.({ upstreamId, startedAtMs, headersAtMs });
    return {
      status: response.status,
      statusText: response.statusText,
      headers: responseHeaderEntries(response),
      body: await createResponseBody(response, env, {
        abort: reason => requestAbort.abort(reason),
        detach: detachParentAbort,
      }),
      ...(facts['provider.modelKey'] === undefined ? {} : { modelKey: facts['provider.modelKey'] }),
      timing: { startedAtMs, headersAtMs },
    };
  },
});

export const bytesToManagedStream = (
  bytes: Uint8Array,
  env: StageEnv<any>,
  label = 'http.body',
): ManagedStream<Uint8Array> => env.createStream<Uint8Array>({
  label,
  async *iterate() {
    if (bytes.byteLength > 0) yield bytes;
  },
});

export const syntheticJsonOutcome = (
  env: StageEnv<any>,
  options: {
    readonly status: number;
    readonly statusText?: string;
    readonly headers?: readonly HeaderEntry[];
    readonly body: unknown;
    readonly modelKey?: string;
  },
): HttpOutcome => {
  const now = env.clock();
  const baseHeaders = options.headers ?? [];
  const headers = hasHeader(baseHeaders, 'content-type')
    ? wrapSensitiveHeaderEntries(baseHeaders)
    : wrapSensitiveHeaderEntries([...baseHeaders, ['content-type', 'application/json'] as const]);
  const encoded = new TextEncoder().encode(JSON.stringify(options.body));
  return {
    status: options.status,
    statusText: options.statusText ?? '',
    headers,
    body: bytesToManagedStream(encoded, env),
    ...(options.modelKey === undefined ? {} : { modelKey: options.modelKey }),
    timing: { startedAtMs: now, headersAtMs: now },
  };
};

export const readManagedBytes = async (stream: ManagedStream<Uint8Array> | null): Promise<Uint8Array> => {
  if (stream === null) return new Uint8Array(0);
  const chunks: Uint8Array[] = [];
  let length = 0;
  for await (const chunk of stream) {
    chunks.push(chunk);
    length += chunk.byteLength;
  }
  const result = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
};

export const headersFromEntries = (entries: readonly HeaderEntry[]): Headers => {
  const headers = new Headers();
  for (const [name, value] of entries) headers.append(name, isSecret(value) ? value.reveal() : value);
  return headers;
};

export type ProviderPipelineStreamOutcome<TEvent> =
  | {
    readonly ok: true;
    readonly events: ManagedStream<ProtocolFrame<TEvent>>;
    readonly modelKey: string;
    readonly http: Pick<HttpOutcome, 'status' | 'statusText' | 'headers' | 'timing'>;
  }
  | {
    readonly ok: false;
    readonly modelKey: string;
    readonly http: HttpOutcome;
  };

const BODY_SNIPPET_CHARS = 1024;

const decodeBodySnippet = (bytes: Uint8Array): string => {
  const text = new TextDecoder().decode(bytes);
  if (text.length === 0) return '<empty>';
  return text.length > BODY_SNIPPET_CHARS ? `${text.slice(0, BODY_SNIPPET_CHARS)}...[truncated]` : text;
};

const readBodySnippet = async (
  stream: ManagedStream<Uint8Array> | null,
): Promise<string> => {
  if (stream === null) return '<empty>';
  // Four UTF-8 bytes cover any code point in the first 1024 characters.
  const chunks: Uint8Array[] = [];
  let length = 0;
  for await (const chunk of stream) {
    const remaining = BODY_SNIPPET_CHARS * 4 - length;
    if (remaining <= 0) break;
    const part = chunk.subarray(0, remaining);
    chunks.push(part);
    length += part.byteLength;
    if (length >= BODY_SNIPPET_CHARS * 4) break;
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return decodeBodySnippet(bytes);
};

export const asyncIterableToReadableStream = <T>(source: AsyncIterable<T>): ReadableStream<T> => {
  const iterator = source[Symbol.asyncIterator]();
  return new ReadableStream<T>({
    async pull(controller) {
      const next = await iterator.next();
      if (next.done) controller.close();
      else controller.enqueue(next.value);
    },
    async cancel() {
      await iterator.return?.();
    },
  });
};

export const parseUpstreamSseOutcome = async <TEvent>(
  outcome: HttpOutcome,
  parser: ProviderStreamParser<TEvent>,
  env: StageEnv<any>,
  label = 'protocol.events',
): Promise<ProviderPipelineStreamOutcome<TEvent>> => {
  if (outcome.status < 200 || outcome.status >= 300) {
    return { ok: false, modelKey: outcome.modelKey ?? '', http: outcome };
  }
  const contentType = headersFromEntries(outcome.headers).get('content-type') ?? '';
  if (outcome.body === null || !isEventStreamMediaType(contentType)) {
    const snippet = await readBodySnippet(outcome.body);
    throw new Error(`Upstream returned ${outcome.status} with content-type "${contentType || 'unknown'}" but stream is required (provider must force stream=true and return text/event-stream when response.ok). Body: ${snippet}`);
  }
  const events = env.wrapStream<Uint8Array, ProtocolFrame<TEvent>>(outcome.body, {
    label,
    transform: (source, signal) => parser(asyncIterableToReadableStream(source), { signal }),
  });
  return {
    ok: true,
    events,
    modelKey: outcome.modelKey ?? '',
    http: {
      status: outcome.status,
      statusText: outcome.statusText,
      headers: outcome.headers,
      timing: outcome.timing,
    },
  };
};

export type ProviderPipelineCompactionOutcome =
  | {
    readonly ok: true;
    readonly result: OpenAIResponsesCompactionResultEx;
    readonly modelKey: string;
    readonly http: Pick<HttpOutcome, 'status' | 'statusText' | 'headers' | 'timing'>;
  }
  | {
    readonly ok: false;
    readonly modelKey: string;
    readonly http: HttpOutcome;
  };

export type ProviderPipelineResponsesOutcome =
  | ({ readonly action: 'generate' } & ProviderPipelineStreamOutcome<OpenAIResponsesStreamEventEx>)
  | ({ readonly action: 'compact' } & ProviderPipelineCompactionOutcome);

export interface ProviderPipelineRerankOutcome {
  readonly target: RerankTarget;
  readonly modelKey: string;
  readonly http: HttpOutcome;
}

export interface ProviderPipelineDecisionOutcome {
  readonly target: DecisionTarget;
  readonly modelKey: string;
  readonly http: HttpOutcome;
}

export type ProviderModelFacts = Omit<ProviderModel, 'enabledFlags'> & {
  readonly enabledFlags: readonly FlagId[];
};

export const toProviderModelFacts = (model: ProviderModel | ProviderModelFacts): ProviderModelFacts => ({
  ...model,
  enabledFlags: Object.freeze([...model.enabledFlags]),
});

export const hasEnabledFlag = (
  model: { readonly enabledFlags: ReadonlySet<FlagId> | readonly FlagId[] },
  flag: FlagId,
): boolean => ('has' in model.enabledFlags ? model.enabledFlags.has(flag) : model.enabledFlags.includes(flag));

export interface RouteCandidate {
  readonly upstreamId: string;
  readonly upstreamName: string;
  readonly kind: UpstreamProviderKind;
  readonly modelId: string;
  readonly upstreamModelId: string;
  readonly endpoints: ProviderModel['endpoints'];
  readonly limits: ProviderModel['limits'];
  readonly providerModel: ProviderModelFacts;
  readonly rules?: AliasRules;
}

interface ProviderPipelineHeaderFacts {
  readonly 'request.inboundHeaders': readonly HeaderEntry[];
  readonly 'route.candidate'?: RouteCandidate;
}

export type ProviderPipelineAlphaSearchInput = ProviderPipelineHeaderFacts & {
  readonly 'provider.model': ProviderModelFacts;
  readonly 'request.payload': Record<string, unknown>;
};

export type ProviderPipelineOpenAICompletionsInput = ProviderPipelineHeaderFacts & {
  readonly 'provider.model': ProviderModelFacts;
  readonly 'request.payload': Omit<OpenAICompletionsPayload, 'model'>;
};

export type ProviderPipelineOpenAIChatCompletionsInput = ProviderPipelineHeaderFacts & {
  readonly 'provider.model': ProviderModelFacts;
  readonly 'request.payload': Omit<OpenAIChatCompletionsPayloadEx, 'model'>;
};

export type ProviderPipelineOpenAIResponsesInput = ProviderPipelineHeaderFacts & {
  readonly 'provider.model': ProviderModelFacts;
  readonly 'request.payload': Omit<CanonicalOpenAIResponsesPayload, 'model'>;
  readonly 'request.action': 'generate' | 'compact';
};

export type ProviderPipelineAnthropicMessagesInput = ProviderPipelineHeaderFacts & {
  readonly 'provider.model': ProviderModelFacts;
  readonly 'request.payload': Omit<AnthropicMessagesPayload, 'model'>;
  readonly 'request.anthropicBeta': readonly string[];
};

export type ProviderPipelineAnthropicMessagesCountTokensInput = ProviderPipelineHeaderFacts & {
  readonly 'provider.model': ProviderModelFacts;
  readonly 'request.payload': Omit<AnthropicMessagesPayload, 'model'>;
  readonly 'request.anthropicBeta': readonly string[];
};

export type ProviderPipelineGeminiGenerateContentInput = ProviderPipelineHeaderFacts & {
  readonly 'provider.model': ProviderModelFacts;
  readonly 'request.payload': GeminiGenerateContentPayload;
  readonly 'request.action': 'generate';
};

export type ProviderPipelineGeminiGenerateContentCountTokensInput = ProviderPipelineHeaderFacts & {
  readonly 'provider.model': ProviderModelFacts;
  readonly 'request.payload': GeminiGenerateContentPayload;
  readonly 'request.action': 'countTokens';
};

export type ProviderPipelineOpenAIEmbeddingsInput = ProviderPipelineHeaderFacts & {
  readonly 'provider.model': ProviderModelFacts;
  readonly 'request.payload': Omit<OpenAIEmbeddingsPayload, 'model'>;
};

export type ProviderPipelineOpenAIImagesGenerationsInput = ProviderPipelineHeaderFacts & {
  readonly 'provider.model': ProviderModelFacts;
  readonly 'request.payload': Omit<OpenAIImagesGenerationsPayload, 'model'>;
};

export type ProviderPipelineOpenAIImagesEditsInput = ProviderPipelineHeaderFacts & {
  readonly 'provider.model': ProviderModelFacts;
  readonly 'request.payload': ImageEditsPipelineRequest;
};

export type ProviderPipelineOpenAIAudioTranscriptionsInput = ProviderPipelineHeaderFacts & {
  readonly 'provider.model': ProviderModelFacts;
  readonly 'request.payload': AudioTranscriptionPipelineRequest;
};

export type ProviderPipelineRerankInput = ProviderPipelineHeaderFacts & {
  readonly 'provider.model': ProviderModelFacts;
  readonly 'request.payload': CanonicalRerankRequest;
};

export type ProviderPipelineDecisionInput = ProviderPipelineHeaderFacts & {
  readonly 'provider.model': ProviderModelFacts;
  readonly 'request.payload': CanonicalDecisionRequest;
};

export interface ProviderPipelines {
  readonly alphaSearch?: Pipeline<ProviderPipelineAlphaSearchInput, HttpOutcome, ProviderPipelineServices>;
  readonly openaiCompletions?: Pipeline<ProviderPipelineOpenAICompletionsInput, HttpOutcome, ProviderPipelineServices>;
  readonly openaiChatCompletions?: Pipeline<ProviderPipelineOpenAIChatCompletionsInput, ProviderPipelineStreamOutcome<OpenAIChatCompletionsStreamEvent>, ProviderPipelineServices>;
  readonly openaiResponses?: Pipeline<ProviderPipelineOpenAIResponsesInput, ProviderPipelineResponsesOutcome, ProviderPipelineServices>;
  readonly anthropicMessages?: Pipeline<ProviderPipelineAnthropicMessagesInput, ProviderPipelineStreamOutcome<AnthropicMessagesStreamEventEx>, ProviderPipelineServices>;
  readonly anthropicMessagesCountTokens?: Pipeline<ProviderPipelineAnthropicMessagesCountTokensInput, HttpOutcome, ProviderPipelineServices>;
  readonly geminiGenerateContent?: Pipeline<ProviderPipelineGeminiGenerateContentInput, ProviderPipelineStreamOutcome<GeminiGenerateContentStreamEvent>, ProviderPipelineServices>;
  readonly geminiGenerateContentCountTokens?: Pipeline<ProviderPipelineGeminiGenerateContentCountTokensInput, HttpOutcome, ProviderPipelineServices>;
  readonly openaiEmbeddings?: Pipeline<ProviderPipelineOpenAIEmbeddingsInput, HttpOutcome, ProviderPipelineServices>;
  readonly openaiImagesGenerations?: Pipeline<ProviderPipelineOpenAIImagesGenerationsInput, HttpOutcome, ProviderPipelineServices>;
  readonly openaiImagesEdits?: Pipeline<ProviderPipelineOpenAIImagesEditsInput, HttpOutcome, ProviderPipelineServices>;
  readonly openaiAudioTranscriptions?: Pipeline<ProviderPipelineOpenAIAudioTranscriptionsInput, HttpOutcome, ProviderPipelineServices>;
  readonly rerank?: Pipeline<ProviderPipelineRerankInput, ProviderPipelineRerankOutcome, ProviderPipelineServices>;
  readonly decision?: Pipeline<ProviderPipelineDecisionInput, ProviderPipelineDecisionOutcome, ProviderPipelineServices>;
}
