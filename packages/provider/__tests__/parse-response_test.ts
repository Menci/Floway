import { describe, expect, expectTypeOf, it, vi } from 'vitest';

import { httpDialError, httpTerminal, parseHttpResponse, parseJsonBody, parseResultResponse, parseSseResponse, stripHeaders, type GatewayFacts, type HttpTerminalFacts, type ProviderServices } from '../src/index.ts';
import { UpstreamTransportError, type Fetcher } from '@floway-dev/http';
import { factSpace, run, Secret } from '@floway-dev/pipeline';
import { decodeAnthropicMessagesStream } from '@floway-dev/protocols/anthropic-messages';
import { isJsonObject } from '@floway-dev/protocols/common';
import { decodeOpenAIAudioSpeechStream } from '@floway-dev/protocols/openai-audio';
import { decodeOpenAIChatCompletionsStream } from '@floway-dev/protocols/openai-chat-completions';

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

const dial = (operation: 'alphaSearch' | 'anthropicMessages' | 'openaiChatCompletions' | 'openaiAudioSpeech') => {
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

const anthropic = compose('anthropic-messages.provider', {
  entry,
  exit: ['response.http', 'response.anthropicMessages'],
  stages: [parseSseResponse('anthropicMessages', decodeAnthropicMessagesStream, format), dial('anthropicMessages')],
  ending: httpTerminal,
});

const speech = compose('openai-audio-speech.provider', {
  entry: [...entry, 'request.openaiAudioSpeech'],
  exit: ['response.http', 'response.openaiAudioSpeech'],
  stages: [
    parseHttpResponse('openaiAudioSpeech', {
      select: payload => payload.stream_format === 'sse' ? 'stream' : 'result',
      stream: decodeOpenAIAudioSpeechStream,
      result: bytes => ({ ok: true, value: bytes }),
      format,
    }),
    dial('openaiAudioSpeech'),
  ],
  ending: httpTerminal,
});

describe('provider HTTP return path', () => {
  it('requires a single operation key for each decoder factory', () => {
    expectTypeOf<Parameters<typeof parseSseResponse<'anthropicMessages' | 'openaiChatCompletions'>>[0]>().toBeNever();
    expectTypeOf<Parameters<typeof parseResultResponse<'alphaSearch' | 'openaiEmbeddings'>>[0]>().toBeNever();
    expectTypeOf<Parameters<typeof parseHttpResponse<'openaiAudioSpeech' | 'openaiAudioTranscriptions'>>[0]>().toBeNever();
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
    expect(response['response.http']).toMatchObject({ status: 200, body: null });
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
      'response.http': { status: 429, statusText: '', headers: [['content-type', 'text/plain;charset=UTF-8'], ['retry-after', '5']], body: null },
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
  ])('preserves an Anthropic Messages $event.type event and reads the remaining source', async ({ event, disconnect }) => {
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
      expect(await reader.next()).toEqual({ done: false, value: { ok: true, value: event } });
      const remaining = Array.fromAsync(reader);
      await draining.promise;
      expect(response.body!.locked).toBe(true);
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
    }, host(() => Promise.resolve(new Response(body, { headers: { 'content-type': 'text/event-stream' } }))));
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
});
