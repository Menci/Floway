import { expect, test } from 'vitest';

import { openaiCompletionsIngress } from '../../../../src/data-plane/non-chat/openai-completions/index.ts';
import { bodyStream, mediaCandidate, mediaHost, mediaRequest } from '../openai-audio/media-fixture.ts';
import { run } from '@floway-dev/pipeline';

test('text completions deliver incrementally and meter the upstream usage chunk suppressed for the client', async () => {
  const bytes = new TextEncoder();
  const upstream = Promise.withResolvers<ReadableStreamDefaultController<Uint8Array>>();
  const partial = 'data: {"choices":[{"index":0,"text":"first"}]}\n\n';
  const host = mediaHost([mediaCandidate('completion', 'chat', { openaiCompletions: {} })], () => async (_url, init) => {
    if (typeof init.body !== 'string') throw new TypeError('Expected text completion JSON');
    expect(JSON.parse(init.body)).toEqual({
      model: 'wire-model', prompt: 'Example', stream: true, stream_options: { include_usage: true, custom: 'kept' },
    });
    return new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes.encode(partial));
        upstream.resolve(controller);
      },
    }), { headers: { 'content-type': 'text/event-stream' } });
  });
  const execution = run(openaiCompletionsIngress, await mediaRequest('/completions', {
    model: 'public-model', prompt: 'Example', stream: true, stream_options: { include_usage: false, custom: 'kept' },
  }), host.options);
  const answer = await execution.result;
  const reader = execution.read(bodyStream(answer.http));
  await expect(reader.next()).resolves.toEqual({ done: false, value: { ok: true, value: bytes.encode(partial) } });
  expect(host.recordPerformance).not.toHaveBeenCalled();
  const controller = await upstream.promise;
  controller.enqueue(bytes.encode('data: {"choices":[],"usage":{"prompt_tokens":3,"completion_tokens":2,"total_tokens":5}}\n\ndata: [DONE]\n\n'));
  controller.close();
  await expect(reader.next()).resolves.toEqual({ done: false, value: { ok: true, value: bytes.encode('data: [DONE]\n\n') } });
  await expect(reader.next()).resolves.toMatchObject({ done: true });
  await expect(execution.read(answer.usage!)).resolves.toMatchObject({ kind: 'observed', usage: [{ quantities: { input_tokens: '3', output_tokens: '2' } }] });
  host.controller.abort();
  execution.discard(answer);
  await host.settle();
  expect(host.recordPerformance).toHaveBeenCalledWith(expect.objectContaining({ operation: 'text_completion', failed: false }));
  expect(host.recordUsage).toHaveBeenCalledOnce();
  expect(host.errors).toEqual([]);
});

test('text completion cancellation ends the encoded stream as a local abort', async () => {
  const reason = new Error('test downstream cancelled');
  const partial = new TextEncoder().encode('data: {"choices":[{"index":0,"text":"first"}]}\n\n');
  const host = mediaHost([mediaCandidate('completion', 'chat', { openaiCompletions: {} })], () => async (_url, init) => {
    const signal = init.signal;
    if (signal == null) throw new TypeError('Expected an owned upstream signal');
    return new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(partial);
        signal.addEventListener('abort', () => controller.error(signal.reason), { once: true });
      },
    }), { headers: { 'content-type': 'text/event-stream' } });
  });
  const request = await mediaRequest('/completions', { model: 'public-model', prompt: 'Example', stream: true });
  const execution = run(openaiCompletionsIngress, request, host.options);
  const answer = await execution.result;
  const reader = execution.read(bodyStream(answer.http));
  await expect(reader.next()).resolves.toEqual({ done: false, value: { ok: true, value: partial } });
  host.controller.abort(reason);
  await expect(reader.next()).resolves.toEqual({
    done: false, value: { ok: false, error: { kind: 'abort', cause: expect.objectContaining({ cause: reason }) } },
  });
  await expect(reader.next()).resolves.toMatchObject({ done: true });
  await expect(execution.read(answer.usage!)).resolves.toEqual({ kind: 'local' });
  execution.discard(answer);
  await host.settle();
  expect(host.recordPerformance).not.toHaveBeenCalled();
  expect(host.recordUsage).not.toHaveBeenCalled();
  expect(host.errors).toEqual([]);
});

const completionWithUsage = (usage: Record<string, unknown>) => {
  const host = mediaHost([mediaCandidate('completion', 'chat', { openaiCompletions: {} })], () => async () => new Response(JSON.stringify({
    id: 'cmpl-1', object: 'text_completion', created: 1, model: 'wire-model',
    choices: [{ index: 0, text: 'answer', finish_reason: 'stop' }],
    usage,
  }), { headers: { 'content-type': 'application/json' } }));
  return {
    host,
    start: async () => run(openaiCompletionsIngress, await mediaRequest('/completions', {
      model: 'public-model', prompt: 'Example',
    }), host.options),
  };
};

test.each([
  {
    label: 'nested cached_tokens',
    usage: { prompt_tokens: 100, completion_tokens: 7, total_tokens: 107, prompt_tokens_details: { cached_tokens: 80 } },
    quantities: { input_tokens: '20', input_cache_read_tokens: '80', output_tokens: '7' },
  },
  {
    label: 'cache hit and miss extensions',
    usage: { prompt_tokens: 200, completion_tokens: 5, total_tokens: 205, prompt_cache_hit_tokens: 128, prompt_cache_miss_tokens: 72 },
    quantities: { input_tokens: '72', input_cache_read_tokens: '128', output_tokens: '5' },
  },
  {
    label: 'exclusive cached tokens corroborated by the total',
    usage: { prompt_tokens: 479, completion_tokens: 373, total_tokens: 14164, prompt_tokens_details: { cached_tokens: 13312 } },
    quantities: { input_tokens: '479', input_cache_read_tokens: '13312', output_tokens: '373' },
  },
])('text completions meters $label', async ({ usage, quantities }) => {
  const { host, start } = completionWithUsage(usage);
  const execution = await start();
  const answer = await execution.result;
  expect(answer.http?.status).toBe(200);
  await expect(execution.read(answer.usage!)).resolves.toMatchObject({ kind: 'observed', usage: [{ quantities }] });
  host.controller.abort();
  execution.discard(answer);
  await host.settle();
  expect(host.recordUsage).toHaveBeenCalledWith(expect.objectContaining({ modelKey: 'wire-model' }), expect.objectContaining({ quantities }));
  expect(host.errors).toEqual([]);
});

test.each([
  { prompt_tokens: 40, completion_tokens: 1, total_tokens: 41, prompt_tokens_details: { cached_tokens: 50 } },
  { prompt_tokens: 40, completion_tokens: 1, total_tokens: 41, prompt_cache_hit_tokens: 1.5 },
])('text completions fails loudly on inconsistent cache counts', async usage => {
  const { host, start } = completionWithUsage(usage);
  const execution = await start();
  await expect(execution.result).rejects.toBeInstanceOf(RangeError);
  host.controller.abort();
  await host.settle();
  expect(host.recordUsage).not.toHaveBeenCalled();
  expect(host.recordPerformance).not.toHaveBeenCalled();
});
