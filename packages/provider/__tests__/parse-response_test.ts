import { describe, expect, expectTypeOf, it, vi } from 'vitest';

import { httpDialError, httpTerminal, parseHttpResponse, parseJsonBody, parseResultResponse, parseSseResponse, stripHeaders, type GatewayFacts, type HttpTerminalFacts, type ProviderResponseFacts, type ProviderServices } from '../src/index.ts';
import { UpstreamTransportError, type Fetcher } from '@floway-dev/http';
import { factSpace, run, Secret } from '@floway-dev/pipeline';
import { decodeAnthropicMessagesCountTokensResult, decodeAnthropicMessagesStream, type AnthropicMessagesCountTokensResult } from '@floway-dev/protocols/anthropic-messages';
import { isJsonObject } from '@floway-dev/protocols/common';
import { decodeGeminiGenerateContentCountTokensResult, type GeminiGenerateContentCountTokensResult } from '@floway-dev/protocols/gemini-generate-content';
import { decodeOpenAIAudioSpeechStream } from '@floway-dev/protocols/openai-audio';
import { decodeOpenAIChatCompletionsStream } from '@floway-dev/protocols/openai-chat-completions';
import { parseRerankResponse } from '@floway-dev/protocols/rerank';

const { compose, defineStage } = factSpace<GatewayFacts & HttpTerminalFacts, ProviderServices>();
const entry = ['request.http', 'provider.upstream'] as const;
const request: Pick<GatewayFacts, typeof entry[number]> = {
  'request.http': { method: 'POST', url: 'https://client.example/v1/chat/completions', headers: [['X-Sample', 'a'], ['x-sample', 'b'], ['x-remove', 'c']], body: new Uint8Array([5]) },
  'provider.upstream': { id: 'example', name: 'Example', kind: 'custom', config: {} },
};
const format = (status: number | null, message: string) => ({ error: { status, message } });
const host = (fetcher: Fetcher, signal = new AbortController().signal) => ({
  signal,
  waitUntil: (_task: Promise<unknown>) => {},
  services: { fetcher: () => async (url: string, init: Parameters<Fetcher>[1]) => ({ response: await fetcher(url, init) }) },
});

const dial = (operation: 'alphaSearch' | 'anthropicMessages' | 'anthropicMessagesCountTokens' | 'geminiGenerateContentCountTokens' | 'openaiChatCompletions' | 'openaiAudioSpeech' | 'rerank') => {
  const outcome = `response.${operation}` as const;
  return defineStage({
    name: 'prepare-dial',
    through: {
      request: { needs: ['request.http'], provides: ['request.http'], consumes: [] },
      response: { needs: ['response.http', 'response.http.error?'], provides: [`${outcome}?`], consumes: ['response.http.error'] },
    },
    async execute(facts, scope) {
      const request = facts['request.http'];
      const { 'response.http.error': failure, ...answer } = await scope.next({
        ...facts,
        'request.http': { ...request, url: 'https://upstream.example/request', headers: [...request.headers, ['authorization', Secret.from('test')]] },
      });
      return failure === undefined ? answer : { ...answer, [outcome]: httpDialError(failure, format) };
    },
  });
};

const chat = compose('openai-chat-completions.provider', {
  entry,
  exit: ['response.http', 'response.openaiChatCompletions'],
  stages: [
    stripHeaders('strip-headers', name => name === 'x-sample'),
    parseSseResponse('openaiChatCompletions', decodeOpenAIChatCompletionsStream, format),
    dial('openaiChatCompletions'),
  ],
  ending: httpTerminal,
});

const scalar = compose('alpha-search.provider', {
  entry,
  exit: ['response.http', 'response.alphaSearch'],
  stages: [
    parseResultResponse('alphaSearch', bytes => {
      const result = parseJsonBody(bytes);
      if (!result.ok) return result;
      if (!isJsonObject(result.value)) return { ok: false, error: new Error('Expected search results as JSON') };
      return { ok: true, value: result.value };
    }, format),
    dial('alphaSearch'),
  ],
  ending: httpTerminal,
});

const meteredScalar = compose('embeddings.provider', {
  entry,
  exit: ['response.http', 'response.openaiEmbeddings', 'response.usageModelKey?'],
  stages: [
    parseResultResponse('openaiEmbeddings', () => ({ ok: true, value: {} }), format),
    defineStage({
      name: 'prepare-embedding-dial',
      through: {
        request: { needs: [], provides: [], consumes: [] },
        response: {
          needs: ['response.http', 'response.http.error?'],
          provides: ['response.openaiEmbeddings?', 'response.usageModelKey?'],
          consumes: ['response.http.error'],
        },
      },
      async execute(facts, scope) {
        const { 'response.http.error': failure, ...answer } = await scope.next(facts);
        if (failure !== undefined) return { ...answer, 'response.openaiEmbeddings': httpDialError(failure, format) };
        return { ...answer, 'response.usageModelKey': 'wire-model' };
      },
    }),
  ],
  ending: httpTerminal,
});

const anthropic = compose('anthropic-messages.provider', {
  entry,
  exit: ['response.http', 'response.anthropicMessages'],
  stages: [parseSseResponse('anthropicMessages', decodeAnthropicMessagesStream, format), dial('anthropicMessages')],
  ending: httpTerminal,
});

const anthropicCountParser = parseResultResponse('anthropicMessagesCountTokens', {
  needs: [], noContent: null, format,
  decode(bytes) {
    const parsed = parseJsonBody(bytes);
    return parsed.ok ? decodeAnthropicMessagesCountTokensResult(parsed.value) : parsed;
  },
});

const anthropicCount = compose('anthropic-messages.count-tokens.provider', {
  entry,
  exit: ['response.http', 'response.anthropicMessagesCountTokens'],
  stages: [anthropicCountParser, dial('anthropicMessagesCountTokens')],
  ending: httpTerminal,
});

const geminiCount = compose('gemini-generate-content.count-tokens.provider', {
  entry,
  exit: ['response.http', 'response.geminiGenerateContentCountTokens'],
  stages: [parseResultResponse('geminiGenerateContentCountTokens', {
    needs: [], noContent: null, format,
    decode(bytes) {
      const parsed = parseJsonBody(bytes);
      return parsed.ok ? decodeGeminiGenerateContentCountTokensResult(parsed.value) : parsed;
    },
  }), dial('geminiGenerateContentCountTokens')],
  ending: httpTerminal,
});

const speech = compose('openai-audio-speech.provider', {
  entry: [...entry, 'request.openaiAudioSpeech'],
  exit: ['response.http', 'response.openaiAudioSpeech'],
  stages: [
    parseHttpResponse('openaiAudioSpeech', {
      select: payload => payload.stream_format === 'sse' ? 'stream' : 'result',
      stream: decodeOpenAIAudioSpeechStream,
      needs: ['provider.upstream'] as const,
      result: (bytes, _http, facts) => {
        expectTypeOf(facts).toEqualTypeOf<Pick<GatewayFacts, 'provider.upstream'>>();
        expect(Object.keys(facts)).toEqual(['provider.upstream']);
        return { ok: true, value: bytes };
      },
      format,
    }),
    dial('openaiAudioSpeech'),
  ],
  ending: httpTerminal,
});

describe('provider HTTP return path', () => {
  it.each([200, 400])('omits the dispatch model key when body I/O aborts after HTTP %s headers', async status => {
    const reading = Promise.withResolvers<void>();
    const controller = new AbortController();
    const running = run(meteredScalar, request, host((_url, { signal }) => Promise.resolve(new Response(new ReadableStream<Uint8Array>({
      start(body) {
        signal!.addEventListener('abort', () => body.error(signal!.reason), { once: true });
      },
      pull() { reading.resolve(); },
    }, { highWaterMark: 0 }), { status, headers: { 'x-upstream': 'kept' } })), controller.signal));
    await reading.promise;
    controller.abort();
    const answer = await running.result;
    expect(answer).toMatchObject({
      'response.http': { status, body: null, headers: [['x-upstream', 'kept']] },
      'response.openaiEmbeddings': { kind: 'error', source: 'local' },
    });
    expect(answer).not.toHaveProperty(['response.usageModelKey']);
    await running.done;
  });

  it('keeps the dispatch model key when body I/O fails upstream after headers', async () => {
    const failure = new UpstreamTransportError(new Error('socket reset'));
    const running = run(meteredScalar, request, host(() => Promise.resolve(new Response(new ReadableStream<Uint8Array>({
      pull(body) { body.error(failure); },
    }), { status: 200 }))));
    await expect(running.result).resolves.toMatchObject({
      'response.openaiEmbeddings': { kind: 'error', source: 'upstream' },
      'response.usageModelKey': 'wire-model',
    });
    await running.done;
  });

  it('types the optional dispatch model key and restricts no-content results to nullable operations', () => {
    expectTypeOf<Pick<GatewayFacts, 'response.usageModelKey'>>().toEqualTypeOf<{ 'response.usageModelKey'?: string }>();
    expectTypeOf<Pick<ProviderResponseFacts<'openaiChatCompletions'>, 'response.usageModelKey'>>().toEqualTypeOf<{ 'response.usageModelKey'?: string }>();
    expectTypeOf<Parameters<typeof parseResultResponse<'openaiEmbeddings', readonly []>>[1]['noContent']>().toEqualTypeOf<undefined>();
    expectTypeOf<Extract<GatewayFacts['response.anthropicMessagesCountTokens'], { kind: 'result' }>['result']>().toEqualTypeOf<AnthropicMessagesCountTokensResult | null>();
    expectTypeOf<Extract<GatewayFacts['response.geminiGenerateContentCountTokens'], { kind: 'result' }>['result']>().toEqualTypeOf<GeminiGenerateContentCountTokensResult | null>();
  });

  it.each([204, 205])('preserves a bodyless count response and its HTTP %s head', async status => {
    const runOptions = host(() => Promise.resolve(new Response(null, { status, statusText: 'Upstream status', headers: { 'x-upstream': 'kept' } })));
    const anthropicRun = run(anthropicCount, request, runOptions);
    const geminiRun = run(geminiCount, request, runOptions);
    const expectedHead = { status, statusText: 'Upstream status', headers: [['x-upstream', 'kept']], body: null, startedAt: expect.any(Number) };
    await expect(anthropicRun.result).resolves.toEqual({
      'response.http': expectedHead,
      'response.anthropicMessagesCountTokens': { kind: 'result', result: null },
    });
    await expect(geminiRun.result).resolves.toEqual({
      'response.http': expectedHead,
      'response.geminiGenerateContentCountTokens': { kind: 'result', result: null },
    });
    await Promise.all([anthropicRun.done, geminiRun.done]);
  });

  it.each([
    ['an absent body at 200', 200, null],
    ['empty bytes at 200', 200, ''],
    ['JSON null at 200', 200, 'null'],
    ['an absent body at 304', 304, null],
  ] as const)('returns an upstream count error for %s', async (_description, status, body) => {
    const runOptions = host(() => Promise.resolve(new Response(body, { status })));
    const anthropicRun = run(anthropicCount, request, runOptions);
    const geminiRun = run(geminiCount, request, runOptions);
    await expect(anthropicRun.result).resolves.toMatchObject({
      'response.http': { status, body: null },
      'response.anthropicMessagesCountTokens': { kind: 'error', source: 'upstream' },
    });
    await expect(geminiRun.result).resolves.toMatchObject({
      'response.http': { status, body: null },
      'response.geminiGenerateContentCountTokens': { kind: 'error', source: 'upstream' },
    });
    await Promise.all([anthropicRun.done, geminiRun.done]);
  });

  it('does not treat a present managed body as absent at status 205', async () => {
    const ending = defineStage({
      name: 'raw-count-http',
      request: { needs: [] },
      return: { provides: ['response.http'] },
      async execute(_facts, scope) {
        const body = scope.createStream<Uint8Array, never>(async function* () {
          yield { ok: true, value: new TextEncoder().encode('null') };
        });
        return { 'response.http': { status: 205, statusText: 'Reset Content', headers: [], body } };
      },
    });
    const pipeline = compose('anthropic-messages.count-tokens.present-body', {
      entry: [],
      exit: ['response.http', 'response.anthropicMessagesCountTokens'],
      stages: [anthropicCountParser],
      ending,
    });
    const running = run(pipeline, {}, host(() => { throw new Error('The custom terminal owns this response'); }));
    await expect(running.result).resolves.toMatchObject({
      'response.http': { status: 205, body: null },
      'response.anthropicMessagesCountTokens': { kind: 'error', source: 'upstream' },
    });
    await running.done;
  });

  it('requires a single operation key for each decoder factory', () => {
    expectTypeOf<Parameters<typeof parseSseResponse<'anthropicMessages' | 'openaiChatCompletions'>>[0]>().toBeNever();
    expectTypeOf<Parameters<typeof parseResultResponse<'alphaSearch' | 'openaiEmbeddings'>>[0]>().toBeNever();
    expectTypeOf<Parameters<typeof parseHttpResponse<'openaiAudioSpeech' | 'openaiAudioTranscriptions'>>[0]>().toBeNever();
  });

  it.each(['local', 'upstream'] as const)('checks the %s error accompanying a null-body HTTP answer', async source => {
    const answer: Pick<GatewayFacts, 'response.http' | 'response.alphaSearch'> = {
      'response.http': { status: 429, statusText: 'Too Many Requests', headers: [['Retry-After', '15']], body: null },
      'response.alphaSearch': { kind: 'error', source, error: format(429, 'rate limited') },
    };
    const decode = vi.fn(() => { throw new Error('an authored outcome should not be decoded'); });
    const pipeline = compose('rate-limited', {
      entry: [],
      exit: ['response.http', 'response.alphaSearch'],
      stages: [parseResultResponse('alphaSearch', decode, format)],
      ending: defineStage({
        name: 'rate-limit', request: { needs: [] }, return: { provides: ['response.http', 'response.alphaSearch'] },
        async execute() { return answer; },
      }),
    });
    const running = run(pipeline, {}, host(() => { throw new Error('rate limiting does not dial'); }));
    if (source === 'local') {
      const local = await running.result;
      expect(local).toBe(answer);
      expect(local['response.http']).not.toHaveProperty('startedAt');
      await running.done;
    } else {
      await expect(running.result).rejects.toThrow('expected an unparsed HTTP response or an explicit local error');
      await expect(running.done).rejects.toThrow('expected an unparsed HTTP response or an explicit local error');
    }
    expect(decode).not.toHaveBeenCalled();
  });

  it('still rejects a bodyless upstream response to a streaming request', async () => {
    const running = run(chat, request, host(() => Promise.resolve(new Response(null, { status: 204 }))));
    await expect(running.result).resolves.toMatchObject({
      'response.http': { status: 204, body: null },
      'response.openaiChatCompletions': { kind: 'error', source: 'upstream' },
    });
    await running.done;
  });

  it('passes the captured request facts and no others to the result decoder', async () => {
    const stage = parseResultResponse('alphaSearch', {
      needs: ['request.alphaSearch'] as const,
      decode(_bytes, _http, facts) {
        expectTypeOf(facts).toEqualTypeOf<Pick<GatewayFacts, 'request.alphaSearch'>>();
        expect(Object.keys(facts)).toEqual(['request.alphaSearch']);
        return { ok: true, value: facts['request.alphaSearch'] };
      },
      format,
    });
    const rewrite = defineStage({
      name: 'rewrite-search',
      through: {
        request: { needs: ['request.alphaSearch'], provides: ['request.alphaSearch'], consumes: [] },
        response: { needs: [], provides: [], consumes: [] },
      },
      async execute(facts, scope) { return await scope.next({ ...facts, 'request.alphaSearch': { query: 'changed' } }); },
    });
    const pipeline = compose('captured-request', {
      entry: [...entry, 'request.alphaSearch'],
      exit: ['response.http', 'response.alphaSearch'],
      stages: [stage, rewrite, dial('alphaSearch')],
      ending: httpTerminal,
    });
    const original = { query: 'original' };
    const running = run(pipeline, { ...request, 'request.alphaSearch': original }, host(() => Promise.resolve(new Response('{}'))));
    const outcome = (await running.result)['response.alphaSearch'];
    if (outcome.kind !== 'result') throw new Error('Expected a scalar outcome');
    expect(outcome.result).toBe(original);
    await running.done;
  });

  it.each(['same', 'cross', 'malformed'] as const)('keeps the appropriate rerank outcome for a %s dialect response', async kind => {
    const stage = parseResultResponse('rerank', {
      needs: ['request.rerank'] as const,
      format,
      decode(bytes, _http, facts) {
        const parsed = parseJsonBody(bytes);
        if (!parsed.ok) return parsed;
        try {
          const canonical = parseRerankResponse('cohere-v2', parsed.value);
          return { ok: true, value: facts['request.rerank'].sourceProtocol === 'cohere-v2' ? bytes : canonical };
        } catch (error) {
          return { ok: false, error };
        }
      },
    });
    const pipeline = compose('rerank-result', {
      entry: [...entry, 'request.rerank'],
      exit: ['response.http', 'response.rerank'],
      stages: [stage, dial('rerank')],
      ending: httpTerminal,
    });
    const bytes = new TextEncoder().encode(kind === 'malformed' ? '{"future":true}' : ' { "results": [{"index":0,"relevance_score":0.9}], "future": {"weight":1.00} }\n');
    const running = run(pipeline, {
      ...request,
      'request.rerank': { sourceProtocol: kind === 'cross' ? 'cohere-v1' : 'cohere-v2', raw: {}, query: 'test', documents: ['a'] },
    }, host(() => Promise.resolve(new Response(bytes))));
    const outcome = (await running.result)['response.rerank'];
    if (kind === 'same') expect(outcome).toEqual({ kind: 'result', result: bytes });
    else if (kind === 'cross') expect(outcome).toMatchObject({ kind: 'result', result: { results: [{ index: 0, relevanceScore: 0.9 }] } });
    else expect(outcome).toMatchObject({ kind: 'error', source: 'upstream' });
    await running.done;
  });

  it.each([false, true])('assigns the pre-header error source when cancelled=%s and consumes the HTTP error fact', async cancelled => {
    const cause = new Error('connection reset');
    const controller = new AbortController();
    const fetcher: Fetcher = (_url, init) => {
      if (!cancelled) return Promise.reject(new UpstreamTransportError(cause));
      return new Promise((_resolve, reject) => {
        init.signal!.addEventListener('abort', () => { reject(init.signal!.reason); });
        controller.abort();
      });
    };
    const running = run(chat, request, host(fetcher, controller.signal));
    expect(await running.result).toEqual({
      'response.http': null,
      'response.openaiChatCompletions': {
        kind: 'error',
        source: cancelled ? 'local' : 'upstream',
        error: format(null, cancelled ? 'Upstream request cancelled' : cause.message),
      },
    });
    await running.done;
  });

  it('requires the dial stage to consume its optional HTTP error', () => {
    expect(() => compose('missing-dial', {
      entry,
      exit: ['response.http', 'response.openaiChatCompletions'],
      stages: [parseSseResponse('openaiChatCompletions', decodeOpenAIChatCompletionsStream, format)],
      ending: httpTerminal,
    })).toThrow(/response\.http\.error/);
  });

  it('filters headers in a standalone stage and decodes a chat stream at a sentinel-free EOF', async () => {
    const event = { id: 'upstream-id', choices: [] };
    const fetcher = vi.fn<Fetcher>(() => Promise.resolve(new Response(`data: ${JSON.stringify(event)}\n\n`, { headers: { 'content-type': 'text/event-stream' } })));
    const running = run(chat, request, host(fetcher));
    const response = await running.result;
    const outcome = response['response.openaiChatCompletions'];
    expect(response['response.http']).toMatchObject({ status: 200, body: null, startedAt: expect.any(Number) });
    expect(fetcher).toHaveBeenCalledExactlyOnceWith('https://upstream.example/request', expect.objectContaining({
      headers: [['X-Sample', 'a'], ['x-sample', 'b'], ['authorization', 'test']],
      body: request['request.http'].body,
    }));
    if (outcome.kind !== 'stream') throw new Error('Expected a stream outcome');
    expect(await Array.fromAsync(running.read(outcome.stream))).toEqual([{ ok: true, value: event }]);
    await running.done;
  });

  it.each([
    ['{"failure":"upstream"}', { failure: 'upstream' }],
    ['null', null],
    ['raw upstream error', format(429, 'raw upstream error')],
  ])('preserves the error response status and headers for %s', async (body, error) => {
    const running = run(chat, request, host(() => Promise.resolve(new Response(body, { status: 429, headers: { 'retry-after': '5' } }))));
    expect(await running.result).toEqual({
      'response.http': { status: 429, statusText: '', headers: [['content-type', 'text/plain;charset=UTF-8'], ['retry-after', '5']], body: null, startedAt: expect.any(Number) },
      'response.openaiChatCompletions': { kind: 'error', source: 'upstream', error },
    });
    await running.done;
  });

  it('returns a malformed stream frame before the discarded body finishes draining', async () => {
    const release = Promise.withResolvers<void>();
    const draining = Promise.withResolvers<void>();
    const response = new Response(new ReadableStream<Uint8Array>({
      start(body) { body.enqueue(new TextEncoder().encode('data: {malformed}\n\n')); },
      async pull(body) {
        draining.resolve();
        await release.promise;
        body.close();
      },
    }, { highWaterMark: 0 }), { headers: { 'content-type': 'text/event-stream' } });
    const running = run(chat, request, host(() => Promise.resolve(response)));
    try {
      const outcome = (await running.result)['response.openaiChatCompletions'];
      if (outcome.kind !== 'stream') throw new Error('Expected a stream outcome');
      expect(await Array.fromAsync(running.read(outcome.stream))).toEqual([
        { ok: false, error: { kind: 'protocol', cause: expect.any(Error) } },
      ]);
      await running.done;
      await draining.promise;
      expect(response.body!.locked).toBe(true);
    } finally {
      release.resolve();
    }
  });

  it.each([
    { event: { type: 'message_stop' }, disconnect: true },
    { event: { type: 'error', error: { type: 'overloaded_error', message: 'busy' } }, disconnect: false },
  ])('handles an Anthropic Messages $event.type event and resolves the remaining source custody', async ({ event, disconnect }) => {
    const release = Promise.withResolvers<void>();
    const draining = Promise.withResolvers<void>();
    const failure = new UpstreamTransportError(new Error('connection reset after the terminal event'));
    const response = new Response(new ReadableStream<Uint8Array>({
      start(body) {
        body.enqueue(new TextEncoder().encode(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`));
      },
      async pull(body) {
        draining.resolve();
        await release.promise;
        if (disconnect) {
          body.error(failure);
          return;
        }
        body.enqueue(new TextEncoder().encode('trailing bytes\n'));
        body.close();
      },
    }, { highWaterMark: 0 }), { headers: { 'content-type': 'text/event-stream' } });
    const running = run(anthropic, request, host(() => Promise.resolve(response)));
    try {
      const outcome = (await running.result)['response.anthropicMessages'];
      if (outcome.kind !== 'stream') throw new Error('Expected a stream outcome');
      const reader = running.read(outcome.stream);
      const terminal = disconnect
        ? { ok: true, value: event }
        : { ok: false, error: { kind: 'protocol', cause: expect.any(Error), event } };
      expect(await reader.next()).toEqual({ done: false, value: terminal });
      const remaining = Array.fromAsync(reader);
      await draining.promise;
      expect(response.body!.locked).toBe(true);
      if (!disconnect) await running.done;
      release.resolve();
      expect(await remaining).toEqual(disconnect ? [{ ok: false, error: { kind: 'transport', cause: failure } }] : []);
      await running.done;
    } finally {
      release.resolve();
    }
  });

  it('hands off the same source Err after a decoded event', async () => {
    const event = { id: 'a', choices: [] };
    const failure = new UpstreamTransportError(new Error('connection reset'));
    const body = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`)); },
      pull(controller) { controller.error(failure); },
    }, { highWaterMark: 0 });
    const running = run(chat, request, host(() => Promise.resolve(new Response(body, { headers: { 'content-type': 'text/event-stream' } }))));
    const outcome = (await running.result)['response.openaiChatCompletions'];
    if (outcome.kind !== 'stream') throw new Error('Expected a stream outcome');
    expect(await Array.fromAsync(running.read(outcome.stream))).toEqual([
      { ok: true, value: event },
      { ok: false, error: { kind: 'transport', cause: failure } },
    ]);
    await running.done;
  });

  it('panics on a decoder returning successfully while it still holds the HTTP source', async () => {
    const early = parseSseResponse('openaiChatCompletions', async function* (source) {
      for await (const item of source) {
        if (!item.ok) yield item;
        return;
      }
    }, format);
    const pipeline = compose('early-decoder', {
      entry,
      exit: ['response.http', 'response.openaiChatCompletions'],
      stages: [early, dial('openaiChatCompletions')],
      ending: httpTerminal,
    });
    const draining = Promise.withResolvers<void>();
    const running = run(pipeline, request, host(() => Promise.resolve(new Response(new ReadableStream<Uint8Array>({
      start(body) { body.enqueue(new Uint8Array([5])); },
      pull(body) {
        draining.resolve();
        body.error(new UpstreamTransportError(new Error('late disconnect')));
      },
    }, { highWaterMark: 0 }), { headers: { 'content-type': 'text/event-stream' } }))));
    const outcome = (await running.result)['response.openaiChatCompletions'];
    if (outcome.kind !== 'stream') throw new Error('Expected a stream outcome');
    await expect(running.read(outcome.stream).next()).rejects.toThrow('before reading the HTTP body to native done');
    await expect(running.done).rejects.toThrow('before reading the HTTP body to native done');
    await draining.promise;
  });

  it('includes the upstream status and response snippet when an SSE call receives a non-SSE 2xx', async () => {
    const running = run(chat, request, host(() => Promise.resolve(new Response('unexpected upstream HTML', { headers: { 'content-type': 'text/html' } }))));
    expect(await running.result).toMatchObject({
      'response.http': { status: 200, body: null, headers: [['content-type', 'text/html']] },
      'response.openaiChatCompletions': { kind: 'error', source: 'upstream', error: format(502, 'Upstream returned 200 with content-type "text/html" but stream is required. Body: unexpected upstream HTML') },
    });
    await running.done;
  });

  it.each([
    ['{"data":[1]}', { kind: 'result', result: { data: [1] } }],
    ['[]', { kind: 'error', source: 'upstream', error: format(200, 'Expected search results as JSON') }],
  ])('produces the scalar protocol outcome for %s', async (body, outcome) => {
    const running = run(scalar, request, host(() => Promise.resolve(new Response(body))));
    expect(await running.result).toMatchObject({ 'response.http': { status: 200, body: null }, 'response.alphaSearch': outcome });
    await running.done;
  });

  it.each(['audio', 'sse'] as const)('uses the owner-selected decoder for speech format %s', async streamFormat => {
    const body = 'data: {"type":"speech.audio.delta","audio":"AA=="}\n\n';
    const running = run(speech, {
      ...request,
      'request.openaiAudioSpeech': { model: 'test', input: 'text', voice: 'voice', stream_format: streamFormat },
    }, host(() => Promise.resolve(new Response(body, { headers: { 'content-type': streamFormat === 'sse' ? 'text/event-stream' : 'audio/wav' } }))));
    const outcome = (await running.result)['response.openaiAudioSpeech'];
    if (streamFormat === 'sse') {
      if (outcome.kind !== 'stream') throw new Error('Expected parsed speech events');
      expect(await Array.fromAsync(running.read(outcome.stream))).toEqual([
        { ok: true, value: { type: 'speech.audio.delta', audio: 'AA==' } },
      ]);
    } else {
      expect(outcome).toEqual({ kind: 'result', result: new TextEncoder().encode(body) });
    }
    await running.done;
  });

  it('discards an SSE body when the mixed-mode parser selected a scalar response', async () => {
    const release = Promise.withResolvers<void>();
    const draining = Promise.withResolvers<void>();
    const response = new Response(new ReadableStream<Uint8Array>({
      async pull(body) {
        draining.resolve();
        await release.promise;
        body.close();
      },
    }, { highWaterMark: 0 }), { headers: { 'content-type': 'text/event-stream; charset=utf-8', 'x-upstream': 'kept' } });
    const running = run(speech, {
      ...request,
      'request.openaiAudioSpeech': { model: 'test', input: 'text', voice: 'voice', stream_format: 'audio' },
    }, host(() => Promise.resolve(response)));
    try {
      await expect(running.result).resolves.toMatchObject({
        'response.http': { status: 200, headers: [['content-type', 'text/event-stream; charset=utf-8'], ['x-upstream', 'kept']], body: null },
        'response.openaiAudioSpeech': { kind: 'error', source: 'upstream', error: { error: { status: 502 } } },
      });
      await running.done;
      await draining.promise;
      expect(response.body!.locked).toBe(true);
    } finally {
      release.resolve();
    }
  });
});
