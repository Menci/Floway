import { expect, test, vi } from 'vitest';

import {
  buildHttpRequestStage,
  httpTerminal,
  httpUrl,
  parseCompactionStage,
  parseSseStage,
  readHttpBody,
  toProviderModelFacts,
  type ProviderResponsesInput,
  type ProviderResponsesOutput,
  type ProviderServices,
} from '../src/index.ts';
import type { Fetcher } from '@floway-dev/http';
import { compose, run } from '@floway-dev/pipeline';
import { parseOpenAIResponsesStream } from '@floway-dev/protocols/openai-responses';
import { stubProviderModel } from '@floway-dev/test-utils';

const pipeline = compose<ProviderResponsesInput, ProviderResponsesOutput, ProviderServices>('test.responses', {
  stages: [
    parseCompactionStage(),
    parseSseStage('parseSse', parseOpenAIResponsesStream, {
      needs: ['request.action'],
      when: (facts: ProviderResponsesInput) => facts['request.action'] === 'generate',
    }),
    buildHttpRequestStage<ProviderResponsesInput>('request', ['request.headers', 'request.payload', 'provider.model'], facts => {
      const { upstreamModelId } = facts['provider.model'];
      return {
        request: {
          method: 'POST',
          url: httpUrl('https://upstream.test/responses'),
          headers: facts['request.headers'],
          body: { kind: 'json', value: { ...facts['request.payload'], model: upstreamModelId, stream: true } },
        },
        modelKey: upstreamModelId,
      };
    }),
  ],
  ending: httpTerminal('test-upstream'),
});

const invoke = (fetcher: Fetcher, action: ProviderResponsesInput['request.action'] = 'generate') =>
  run(pipeline, {
    'provider.model': toProviderModelFacts(stubProviderModel({ upstreamModelId: 'actual-model' })),
    'request.headers': [['x-request-id', 'request-1']],
    'request.payload': { input: [] },
    'request.action': action,
  }, { services: { fetcher: () => fetcher }, finalizationTimeoutMs: 200 });

test('composes a provider pipeline and parses a successful Responses SSE stream', async () => {
  const handle = invoke(async (url, init) => {
    expect(url).toBe('https://upstream.test/responses');
    expect(new Headers(init.headers).get('x-request-id')).toBe('request-1');
    expect(init.body).toEqual(new TextEncoder().encode('{"input":[],"model":"actual-model","stream":true}'));
    return new Response('data: {"type":"response.output_text.delta","delta":"hi"}\n\ndata: [DONE]\n\n', {
      status: 202,
      headers: { 'content-type': 'Text/Event-Stream; charset=utf-8' },
    });
  });
  const facts = await handle.result;
  expect(facts['response.modelKey']).toBe('actual-model');
  expect(facts['response.http']).toMatchObject({ status: 202, body: null, headers: [['content-type', 'Text/Event-Stream; charset=utf-8']] });
  expect(facts['response.result']).toBeUndefined();
  const events = facts['response.events'];
  if (events === undefined) throw new Error('Expected parsed events');
  expect(await Array.fromAsync(events)).toEqual([
    { type: 'event', event: { type: 'response.output_text.delta', delta: 'hi', sequence_number: 0 } },
    { type: 'done' },
  ]);
  await expect(handle.done).resolves.toEqual({ ok: true });
});

test('releasing parsed events interrupts a blocked body read', async () => {
  const pulling = Promise.withResolvers<void>();
  const readerCancelled = vi.fn();
  const fetched = Promise.withResolvers<AbortSignal>();
  const handle = invoke(async (_url, init) => {
    if (!init.signal) throw new Error('Expected fetch signal');
    fetched.resolve(init.signal);
    return new Response(new ReadableStream<Uint8Array>({
      pull: () => { pulling.resolve(); },
      cancel: readerCancelled,
    }, { highWaterMark: 0 }), { headers: { 'content-type': 'text/event-stream' } });
  });
  const { 'response.events': events } = await handle.result;
  if (events === undefined) throw new Error('Expected parsed events');
  const read = events[Symbol.asyncIterator]().next();
  await pulling.promise;
  await events.close();
  await expect(read).resolves.toMatchObject({ done: true });
  expect(readerCancelled).toHaveBeenCalledOnce();
  expect((await fetched.promise).aborted).toBe(true);
  await expect(handle.done).resolves.toEqual({ ok: true });
});

test('keeps non-2xx content and status available as data', async () => {
  const handle = invoke(async () => new Response('rate limited', { status: 429 }));
  const facts = await handle.result;
  expect(facts['response.events']).toBeUndefined();
  expect(facts['response.modelKey']).toBe('actual-model');
  expect(facts['response.http'].status).toBe(429);
  expect((await readHttpBody(facts['response.http'].body)).utf8()).toBe('rate limited');
  await expect(handle.done).resolves.toEqual({ ok: true });
});

test.each([
  [new Response('{"error":"azure stub"}', { headers: { 'content-type': 'application/json' } }), 'azure stub'],
  [new Response(null, { status: 204, headers: { 'content-type': 'text/event-stream' } }), '<empty>'],
])('throws for a 2xx response without an SSE body', async (response, snippet) => {
  const handle = invoke(async () => response);
  await expect(handle.result).rejects.toThrow(snippet);
  await expect(handle.done).resolves.toMatchObject({ ok: false });
});

test('parses compact JSON and releases the HTTP body from the returned facts', async () => {
  const result = { id: 'compact-1', object: 'response.compaction', output: [] };
  const handle = invoke(async () => Response.json(result), 'compact');
  const facts = await handle.result;
  expect(facts['response.result']).toEqual(result);
  expect(facts['response.events']).toBeUndefined();
  expect(facts['response.http'].body).toBeNull();
  await expect(handle.done).resolves.toEqual({ ok: true });
});
