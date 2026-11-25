import { assert, describe, expect, it, vi } from 'vitest';

import { httpTerminal, type ProviderTransportFacts } from '../src/http-terminal.ts';
import { parseResultBody, parseSseBody, type ProviderSseEof } from '../src/parse-response.ts';
import type { ProviderOperationFacts, ProviderServices, ProviderUpstream } from '../src/pipelines.ts';
import type { HttpRequestFact, HttpStreamError } from '@floway-dev/http';
import { factSpace, move, run, type Result } from '@floway-dev/pipeline';
import { parseOpenAIChatCompletionsStream, type OpenAIChatCompletionsStreamEvent } from '@floway-dev/protocols/openai-chat-completions';

const upstream = move<ProviderUpstream>({ id: 'id', name: 'Test', kind: 'custom', config: {} });
const facts = {
  'request.http': move<HttpRequestFact>({ method: 'POST', url: 'https://example.test/endpoint', headers: [], body: null }),
  'provider.upstream': upstream,
};
const format = (status: number | null, message: string) => ({ error: { status, message } });

const chat = factSpace<ProviderOperationFacts<'openaiChatCompletions'> & ProviderTransportFacts, ProviderServices>();
const parseChat = (eof: ProviderSseEof<OpenAIChatCompletionsStreamEvent>) => chat.defineStage({
  name: 'parseOpenAIChatCompletions',
  through: {
    request: { needs: [], provides: [], consumes: [] },
    response: { needs: ['response.transport'], provides: ['response.http', 'response.openaiChatCompletions'], consumes: ['response.transport'] },
  },
  async execute(facts, scope) {
    const back = await scope.next(facts);
    const { http, outcome } = await parseSseBody(back, scope, parseOpenAIChatCompletionsStream, eof, format);
    const { 'response.transport': _transport, ...response } = back;
    return { ...response, 'response.http': move(http), 'response.openaiChatCompletions': move(outcome) };
  },
});

const composeChat = (eof: ProviderSseEof<OpenAIChatCompletionsStreamEvent>, ending = httpTerminal) => chat.compose('chat.response', {
  entry: ['request.http', 'provider.upstream'],
  exit: ['response.http', 'response.openaiChatCompletions'],
  stages: [parseChat(eof)],
  ending,
});
const chatPipeline = composeChat({ kind: 'complete' });

const audio = factSpace<ProviderOperationFacts<'openaiAudioTranscriptions'> & ProviderTransportFacts, ProviderServices>();
const parseAudio = audio.defineStage({
  name: 'parseOpenAIAudioTranscriptions',
  through: {
    request: { needs: [], provides: [], consumes: [] },
    response: { needs: ['response.transport'], provides: ['response.http', 'response.openaiAudioTranscriptions'], consumes: ['response.transport'] },
  },
  async execute(facts, scope) {
    const back = await scope.next(facts);
    const { http, outcome } = await parseResultBody(back, bytes => ({ ok: true, value: bytes }), format);
    const { 'response.transport': _transport, ...response } = back;
    return { ...response, 'response.http': move(http), 'response.openaiAudioTranscriptions': move(outcome) };
  },
});

const audioPipeline = audio.compose('audio.response', {
  entry: ['request.http', 'provider.upstream'],
  exit: ['response.http', 'response.openaiAudioTranscriptions'],
  stages: [parseAudio],
  ending: httpTerminal,
});

const services = (result: Result<Response, HttpStreamError>): ProviderServices => ({ fetcher: () => async () => result });
const encode = (text: string): Uint8Array<ArrayBuffer> => new TextEncoder().encode(text);
const chunk = { id: 'chunk', object: 'chat.completion.chunk', created: 1, model: 'model', choices: [] };
const event = `data: ${JSON.stringify(chunk)}\n\n`;
const sse = (body: string | ReadableStream<Uint8Array>): Response => new Response(body, { headers: { 'content-type': 'text/event-stream; charset=utf-8' } });

describe('provider response parsing', () => {
  it.each([
    ['{"error":{"message":"original"}}', { error: { message: 'original' } }],
    ['"JSON string"', 'JSON string'],
    ['<html>original body</html>', { error: { status: 429, message: '<html>original body</html>' } }],
  ])('preserves the upstream head and carries %s through the protocol error', async (body, error) => {
    const response = new Response(body, { status: 429, headers: { 'retry-after': '5' } });
    const exchange = run(chatPipeline, facts, { services: services({ ok: true, value: response }) });
    const answer = await exchange.result;

    expect(answer['response.http']).toMatchObject({ status: 429, body: null });
    expect(answer['response.http']?.headers).toContainEqual(['retry-after', '5']);
    const outcome = answer['response.openaiChatCompletions'];
    expect(outcome).toEqual({ kind: 'error', source: 'upstream', error });
    expect('cause' in outcome).toBe(false);
    expect(answer).not.toHaveProperty('response.transport');
    await exchange.done;
  });

  it('records a pre-headers transport cause on the protocol error without an HTTP head', async () => {
    const error: HttpStreamError = { kind: 'transport', cause: new Error('socket refused') };
    const exchange = run(chatPipeline, facts, { services: services({ ok: false, error }) });
    const answer = await exchange.result;

    expect(answer['response.http']).toBeNull();
    const outcome = answer['response.openaiChatCompletions'];
    assert(outcome.kind === 'error');
    expect(outcome).toMatchObject({ kind: 'error', source: 'upstream', error: format(null, 'socket refused') });
    expect(outcome.cause).toBe(error);
    await exchange.done;
  });

  it('stores the scalar bytes on the protocol result and preserves the HTTP head', async () => {
    const bytes = Uint8Array.of(0xff, 0x00, 0x12);
    const exchange = run(audioPipeline, facts, {
      services: services({ ok: true, value: new Response(bytes, { headers: { 'content-type': 'application/octet-stream' } }) }),
    });
    const answer = await exchange.result;

    expect(answer['response.http']).toMatchObject({ status: 200, body: null, headers: [['content-type', 'application/octet-stream']] });
    expect(answer['response.openaiAudioTranscriptions']).toEqual({ kind: 'result', result: bytes });
    await exchange.done;
  });

  it('accepts a normal OpenAI Chat Completions EOF after the last event without a sentinel', async () => {
    const exchange = run(chatPipeline, facts, { services: services({ ok: true, value: sse(event) }) });
    const answer = await exchange.result;
    const outcome = answer['response.openaiChatCompletions'];
    assert(outcome.kind === 'stream');

    expect(answer['response.http']?.body).toBeNull();
    expect(await Array.fromAsync(outcome.stream)).toEqual([{ ok: true, value: chunk }]);
    await exchange.done;
  });

  it('rejects a successful response with the wrong media type without reading its payload', async () => {
    const pull = vi.fn();
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({ pull, cancel }, { highWaterMark: 0 });
    const response = new Response(body, { headers: { 'content-type': 'text/html' } });
    const exchange = run(chatPipeline, facts, { services: services({ ok: true, value: response }) });
    const answer = await exchange.result;

    expect(answer['response.http']).toMatchObject({ status: 200, body: null });
    expect(answer['response.openaiChatCompletions']).toEqual({
      kind: 'error', source: 'upstream', error: format(200, 'Expected an upstream text/event-stream response'),
      cause: { contentType: 'text/html', hasBody: true },
    });
    expect(pull).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledOnce();
    await exchange.done;
  });

  it('applies the caller’s terminal-event policy at a clean EOF', async () => {
    const pipeline = composeChat({ kind: 'terminalEvent', isTerminal: value => value.id === 'terminal' });
    const terminal = { ...chunk, id: 'terminal' };
    const completed = run(pipeline, facts, { services: services({ ok: true, value: sse(`${event}data: ${JSON.stringify(terminal)}\n\n`) }) });
    const gotTerminal = (await completed.result)['response.openaiChatCompletions'];
    assert(gotTerminal.kind === 'stream');
    expect(await Array.fromAsync(gotTerminal.stream)).toEqual([{ ok: true, value: chunk }, { ok: true, value: terminal }]);
    await completed.done;

    const incomplete = run(pipeline, facts, { services: services({ ok: true, value: sse(event) }) });
    const missedTerminal = (await incomplete.result)['response.openaiChatCompletions'];
    assert(missedTerminal.kind === 'stream');
    expect(await Array.fromAsync(missedTerminal.stream)).toEqual([
      { ok: true, value: chunk },
      { ok: false, error: { kind: 'protocol', cause: 'Upstream SSE ended before a terminal event' } },
    ]);
    await incomplete.done;
  });

  it('aborts the child after an SSE terminator and joins native done', async () => {
    const cancel = vi.fn();
    const body = new ReadableStream({ start(controller) { controller.enqueue(encode(`${event}data: [DONE]\n\n`)); }, cancel });
    const exchange = run(chatPipeline, facts, { services: services({ ok: true, value: sse(body) }) });
    const outcome = (await exchange.result)['response.openaiChatCompletions'];
    assert(outcome.kind === 'stream');

    expect(await Array.fromAsync(outcome.stream)).toEqual([{ ok: true, value: chunk }]);
    expect(cancel).toHaveBeenCalledOnce();
    expect(body.locked).toBe(false);
    await exchange.done;
  });

  it('preserves an SSE read failure after an event through the wrapped stream', async () => {
    const cause = new Error('body read failed');
    let sent = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent) controller.error(cause);
        else controller.enqueue(encode(event));
        sent = true;
      },
    }, { highWaterMark: 0 });
    const exchange = run(chatPipeline, facts, { services: services({ ok: true, value: sse(body) }) });
    const outcome = (await exchange.result)['response.openaiChatCompletions'];
    assert(outcome.kind === 'stream');

    expect(await Array.fromAsync(outcome.stream)).toEqual([
      { ok: true, value: chunk },
      { ok: false, error: { kind: 'transport', cause } },
    ]);
    expect(body.locked).toBe(false);
    await exchange.done;
  });

  it('yields the malformed SSE failure before finishing transport cleanup', async () => {
    const release = Promise.withResolvers<void>();
    const cancel = vi.fn(() => release.promise);
    const body = new ReadableStream({ start(controller) { controller.enqueue(encode('data: invalid\n\n')); }, cancel });
    const exchange = run(chatPipeline, facts, { services: services({ ok: true, value: sse(body) }) });
    const outcome = (await exchange.result)['response.openaiChatCompletions'];
    assert(outcome.kind === 'stream');
    const cursor = outcome.stream[Symbol.asyncIterator]();
    const item = await cursor.next();

    expect(item).toMatchObject({ done: false, value: { ok: false, error: { kind: 'protocol', cause: { cause: expect.any(SyntaxError) } } } });
    expect(cancel).toHaveBeenCalledOnce();
    expect(body.locked).toBe(true);
    release.resolve();
    expect((await cursor.next()).done).toBe(true);
    expect(body.locked).toBe(false);
    await exchange.done;
  });

  it('forwards the original transport Err once and drains its managed source', async () => {
    const failure: HttpStreamError = { kind: 'transport', cause: new Error('managed read failed') };
    const drained = vi.fn();
    const ending = chat.defineStage({
      name: 'failedTransportStream',
      request: { needs: ['request.http', 'provider.upstream'] },
      return: { provides: ['response.transport'] },
      async execute(_facts, scope) {
        const body = scope.createStream<Uint8Array, HttpStreamError>(async function* () {
          yield { ok: true, value: encode(event) };
          yield { ok: false, error: failure };
          drained();
        });
        return { 'response.transport': move({ ok: true, value: { status: 200, statusText: '', headers: [['content-type', 'text/event-stream']], body } }) };
      },
    });
    const pipeline = composeChat({ kind: 'complete' }, ending);
    const exchange = run(pipeline, facts, { services: services({ ok: true, value: sse('') }) });
    const outcome = (await exchange.result)['response.openaiChatCompletions'];
    assert(outcome.kind === 'stream');
    const reader = outcome.stream[Symbol.asyncIterator]();

    expect(await reader.next()).toEqual({ done: false, value: { ok: true, value: chunk } });
    const errored = await reader.next();
    assert(!errored.done && !errored.value.ok);
    expect(errored.value.error).toBe(failure);
    expect(drained).not.toHaveBeenCalled();
    expect(await reader.next()).toEqual({ done: true, value: undefined });
    expect(drained).toHaveBeenCalledOnce();
    await exchange.done;
  });

  it('surfaces cancellation of a pending SSE pull as one abort Err', async () => {
    const pulled = Promise.withResolvers<void>();
    const body = new ReadableStream<Uint8Array>({ pull() { pulled.resolve(); } }, { highWaterMark: 0 });
    const abort = new AbortController();
    const exchange = run(chatPipeline, facts, { signal: abort.signal, services: services({ ok: true, value: sse(body) }) });
    const outcome = (await exchange.result)['response.openaiChatCompletions'];
    assert(outcome.kind === 'stream');
    const received = Array.fromAsync(outcome.stream);
    await pulled.promise;
    const cause = new Error('client disconnected');
    abort.abort(cause);

    expect(await received).toEqual([{ ok: false, error: { kind: 'abort', cause } }]);
    expect(body.locked).toBe(false);
    await exchange.done;
  });
});
