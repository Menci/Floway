import type { ChatGPTAccessTokenLog } from '../access-token.ts';
import type { ChatGPTUpstream } from '../config.ts';
import type { ChatGPTAccessError, ChatGPTAuthorization, ChatGPTServices, ChatGPTUnauthorized } from '../service.ts';
import { chatgptFactSpace, type ChatGPTFacts } from './facts.ts';
import { authorizeRequest } from './requests.ts';
import { getHeader, setHeader, type HttpBodyError, type HttpRequestFact, type HttpResponseFact } from '@floway-dev/http';
import type { ManagedStream, Result } from '@floway-dev/pipeline';
import { isEventStreamMediaType, isJsonObject } from '@floway-dev/protocols/common';
import { httpDialError, type FormatProtocolError, type ProtocolError } from '@floway-dev/provider';

const { defineStage } = chatgptFactSpace;

const commonNeeds = ['request.http', 'provider.upstream', 'provider.model'] as const;
const responsesNeeds = [...commonNeeds, 'request.chatgptResponsesIdentity'] as const;
const requestProvides = ['request.http'] as const;
const consumesIdentity = ['request.chatgptResponsesIdentity'] as const;
const responseSide = { needs: ['response.http', 'response.http.error?'], consumes: ['response.http.error'] } as const;

type DialRequest<Operation extends 'openaiResponses' | 'openaiResponsesCompact'> = Pick<ChatGPTFacts, typeof responsesNeeds[number] | `request.${Operation}`>;
type OtherRequest<Operation extends 'alphaSearch' | 'openaiImagesGenerations' | 'openaiImagesEdits'> = Pick<ChatGPTFacts, typeof commonNeeds[number] | `request.${Operation}`>;
type HttpAnswer = Pick<ChatGPTFacts, 'response.http'> & Partial<Pick<ChatGPTFacts, 'response.http.error'>>;
type HttpBody = ManagedStream<Uint8Array, HttpBodyError>;
type ByteResult = Result<Uint8Array, HttpBodyError>;

interface DialScope {
  services: Readonly<ChatGPTServices>;
  signal: AbortSignal;
  log: ChatGPTAccessTokenLog;
  abort(promise: Promise<unknown>): void;
  read(body: HttpBody): AsyncIterableIterator<ByteResult>;
  createStream(factory: () => AsyncGenerator<ByteResult, void, unknown>): HttpBody;
  detach(worker: (scope: { log: { withError(cause: unknown): Pick<ChatGPTAccessTokenLog, 'warn'> } }) => Promise<void>): void;
}

export const dialOpenAIResponses = (prepare: (facts: DialRequest<'openaiResponses'>, installationId: string) => HttpRequestFact, format: FormatProtocolError) => defineStage({
  name: 'chatgpt.openaiResponses.dial',
  through: {
    request: { needs: [...responsesNeeds, 'request.openaiResponses'], provides: requestProvides, consumes: consumesIdentity },
    response: { ...responseSide, provides: ['response.http', 'response.openaiResponses?'] },
  },
  return: { provides: ['response.http', 'response.openaiResponses'] },
  async execute(facts, scope) {
    const { 'request.chatgptResponsesIdentity': identity, ...down } = facts;
    return await dial(scope, {
      upstream: facts['provider.upstream'], format, responsesStream: true, installationId: identity.installationId,
      prepare: installationId => prepare(facts, installationId),
      next: request => scope.next({ ...down, 'request.http': request }),
      error: error => ({ 'response.openaiResponses': error }),
    });
  },
});

export const dialOpenAIResponsesCompact = (prepare: (facts: DialRequest<'openaiResponsesCompact'>, installationId: string) => HttpRequestFact, format: FormatProtocolError) => defineStage({
  name: 'chatgpt.openaiResponsesCompact.dial',
  through: {
    request: { needs: [...responsesNeeds, 'request.openaiResponsesCompact'], provides: requestProvides, consumes: consumesIdentity },
    response: { ...responseSide, provides: ['response.http', 'response.openaiResponsesCompact?'] },
  },
  return: { provides: ['response.http', 'response.openaiResponsesCompact'] },
  async execute(facts, scope) {
    const { 'request.chatgptResponsesIdentity': identity, ...down } = facts;
    return await dial(scope, {
      upstream: facts['provider.upstream'], format, installationId: identity.installationId,
      prepare: installationId => prepare(facts, installationId),
      next: request => scope.next({ ...down, 'request.http': request }),
      error: error => ({ 'response.openaiResponsesCompact': error }),
    });
  },
});

export const dialAlphaSearch = (prepare: (facts: OtherRequest<'alphaSearch'>) => HttpRequestFact, format: FormatProtocolError) => defineStage({
  name: 'chatgpt.alphaSearch.dial',
  through: {
    request: { needs: [...commonNeeds, 'request.alphaSearch'], provides: requestProvides, consumes: [] },
    response: { ...responseSide, provides: ['response.http', 'response.alphaSearch?'] },
  },
  return: { provides: ['response.http', 'response.alphaSearch'] },
  async execute(facts, scope) {
    return await dial(scope, {
      upstream: facts['provider.upstream'], format,
      prepare: () => prepare(facts),
      next: request => scope.next({ ...facts, 'request.http': request }),
      error: error => ({ 'response.alphaSearch': error }),
    });
  },
});

export const dialOpenAIImagesGenerations = (prepare: (facts: OtherRequest<'openaiImagesGenerations'>) => HttpRequestFact, format: FormatProtocolError) => defineStage({
  name: 'chatgpt.openaiImagesGenerations.dial',
  through: {
    request: { needs: [...commonNeeds, 'request.openaiImagesGenerations'], provides: requestProvides, consumes: [] },
    response: { ...responseSide, provides: ['response.http', 'response.openaiImagesGenerations?'] },
  },
  return: { provides: ['response.http', 'response.openaiImagesGenerations'] },
  async execute(facts, scope) {
    return await dial(scope, {
      upstream: facts['provider.upstream'], format, images: true,
      prepare: () => prepare(facts),
      next: request => scope.next({ ...facts, 'request.http': request }),
      error: error => ({ 'response.openaiImagesGenerations': error }),
    });
  },
});

export const dialOpenAIImagesEdits = (prepare: (facts: OtherRequest<'openaiImagesEdits'>) => Promise<HttpRequestFact>, format: FormatProtocolError) => defineStage({
  name: 'chatgpt.openaiImagesEdits.dial',
  through: {
    request: { needs: [...commonNeeds, 'request.openaiImagesEdits'], provides: requestProvides, consumes: [] },
    response: { ...responseSide, provides: ['response.http', 'response.openaiImagesEdits?'] },
  },
  return: { provides: ['response.http', 'response.openaiImagesEdits'] },
  async execute(facts, scope) {
    return await dial(scope, {
      upstream: facts['provider.upstream'], format, images: true,
      prepare: () => prepare(facts),
      next: request => scope.next({ ...facts, 'request.http': request }),
      error: error => ({ 'response.openaiImagesEdits': error }),
    });
  },
});

interface DialOptions<ProtocolFacts> {
  upstream: ChatGPTUpstream;
  format: FormatProtocolError;
  images?: true;
  responsesStream?: true;
  installationId?: string | null;
  prepare(installationId: string): HttpRequestFact | Promise<HttpRequestFact>;
  next(request: HttpRequestFact): Promise<HttpAnswer>;
  error(error: ProtocolError): ProtocolFacts;
}

const dial = async <ProtocolFacts>(scope: DialScope, options: DialOptions<ProtocolFacts>) => {
  const { upstream, images = false, responsesStream = false, format, installationId = null } = options;
  const localFailure = ({ status, type, message }: ChatGPTAccessError) => ({
    'response.http': { status, statusText: '', headers: [['content-type', 'application/json']], body: null } satisfies HttpResponseFact,
    ...options.error({ kind: 'error', source: 'local', error: { error: { type, message } } }),
  });
  const accountId = upstream.config.accounts[0].chatgptAccountId;
  const fetcher = scope.services.fetcher(upstream.id);
  let access: ChatGPTAuthorization = await scope.services.chatgpt.authorize(upstream, async (url, init) => (await fetcher(url, init)).response, { images, log: scope.log, installationId });
  if (access.kind === 'unavailable') return localFailure(access.error);

  const request = await options.prepare(access.installationId);
  let retried = false;
  while (true) {
    const child = options.next(authorizeRequest(request, access, accountId));
    const { 'response.http.error': error, ...answer } = await child;
    if (error !== undefined) return { ...answer, ...options.error(httpDialError(error, format)) };
    const http = answer['response.http'];
    if (http === null) throw new Error('ChatGPT HTTP terminal returned neither a response nor a dial error');

    const success = http.status >= 200 && http.status < 300;
    if (success || http.status === 429) {
      const persist = scope.services.chatgpt.quotaObservation(upstream, http.headers, http.status, images);
      if (persist !== null) {
        scope.detach(async ({ log }) => {
          try {
            await persist();
          } catch (cause) {
            log.withError(cause).warn('Failed to persist ChatGPT quota');
          }
        });
      }
    }
    if (success && responsesStream) {
      const type = getHeader(http.headers, 'content-type');
      if (typeof type !== 'string' || !isEventStreamMediaType(type)) {
        // Codex requests and decodes SSE independently of the response Content-Type.
        // https://github.com/openai/codex/blob/c607da9f371bb66a41cc772c6ddf1989d28137d3/codex-rs/codex-api/src/endpoint/responses.rs#L109-L133
        return { ...answer, 'response.http': { ...http, headers: setHeader(http.headers, 'content-type', 'text/event-stream') } };
      }
    }
    if (http.status !== 401) return answer;

    const { body } = http;
    if (body instanceof Uint8Array) throw new Error('Expected the ChatGPT HTTP terminal to return a body handle');
    const observation = await readUnauthorizedBody(body, scope.read);
    const relay = () => ({
      ...answer, 'response.http': {
        ...http,
        body: body === null ? null : scope.createStream(async function* () { yield* observation.items; }),
      },
    });
    if (!observation.complete) return relay();

    const rejected: ChatGPTUnauthorized = access.reject(parseUnauthorizedError(observation.text));
    if (rejected.kind === 'access-only') {
      scope.detach(async ({ log }) => {
        try {
          await rejected.persist();
        } catch (cause) {
          log.withError(cause).warn('Failed to persist ChatGPT credential termination');
        }
      });
      return relay();
    }
    if (rejected.kind === 'terminated') {
      scope.abort(child);
      await rejected.persist();
      return localFailure(rejected.error);
    }
    if (retried || scope.signal.aborted) return relay();

    // Reading the unauthorized body to native done completes its custody.
    scope.abort(child);
    access = await rejected.refresh();
    if (access.kind === 'unavailable') return localFailure(access.error);
    retried = true;
  }
};

const MAX_UNAUTHORIZED_BODY_BYTES = 1024 * 1024;

const readUnauthorizedBody = async (
  body: HttpBody | null,
  read: DialScope['read'],
) => {
  const items: ByteResult[] = [];
  const decoder = new TextDecoder();
  let length = 0;
  let text = '';
  let complete = true;
  if (body !== null) {
    for await (const item of read(body)) {
      if (!item.ok) complete = false;
      else {
        length += item.value.byteLength;
        if (length > MAX_UNAUTHORIZED_BODY_BYTES) throw new RangeError('ChatGPT 401 response exceeds 1 MiB');
        text += decoder.decode(item.value, { stream: true });
      }
      items.push(item);
    }
  }
  return { complete, items, text: text + decoder.decode() };
};

const parseUnauthorizedError = (text: string): { code: string | null; message: string } => {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
  }
  const root = isJsonObject(value) ? value : null;
  const error = isJsonObject(root?.error) ? root.error : null;
  return {
    code: typeof error?.code === 'string' ? error.code : null,
    message: typeof error?.message === 'string' ? error.message : typeof root?.detail === 'string' ? root.detail : text.slice(0, 256),
  };
};
