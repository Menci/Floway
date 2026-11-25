import { expect, test, vi } from 'vitest';

import type { ComputedUsage } from '../../src/data-plane/pipeline/compute-usage.ts';
import { createPipelineRecorder } from '../../src/dump/archive-recorder.ts';
import { decodeDump } from '@floway-dev/dump/browser';
import { factSpace, move, run, Secret } from '@floway-dev/pipeline';
import type { Deferred, ManagedStream } from '@floway-dev/pipeline';

const request = {
  'request.http': { method: 'POST', url: 'https://floway.example/v1/chat/completions?stream=true', headers: [['authorization', Secret.from('secret credential value')]], body: Uint8Array.of(0xff) },
};

test('streams entry bytes before the run finishes and attributes the selected failover answer by identity', async () => {
  const firstChunk = Promise.withResolvers<string>();
  const commit = vi.fn(async () => {});
  let contents = '';
  const recorder = createPipelineRecorder('key', async (_keyId, _id, bytes) => {
    const reader = bytes.getReader();
    const decoder = new TextDecoder();
    const first = await reader.read();
    contents = decoder.decode(first.value);
    firstChunk.resolve(contents);
    for (let next = await reader.read(); !next.done; next = await reader.read()) contents += decoder.decode(next.value);
    return commit;
  });
  recorder.event({ type: 'stage.entered', stageId: 1, name: 'serve.failover', facts: { ...request, 'serve.model': 'requested' } });
  const started = await firstChunk.promise;
  expect(started).toContain('stage.entered');
  expect(started).not.toContain('secret credential value');
  expect(commit).not.toHaveBeenCalled();

  const first = { 'response.http': { status: 429 }, 'response.modelKey': 'winner-model' };
  const last = { 'response.http': { status: 429 }, 'response.modelKey': 'loser-model' };
  recorder.event({ type: 'stage.entered', stageId: 2, parentStageId: 1, name: 'attempt', facts: { 'serve.candidate': { upstream: { id: 'winner' } } } });
  recorder.event({ type: 'stage.leaved', stageId: 2, facts: first });
  recorder.event({ type: 'stage.entered', stageId: 3, parentStageId: 1, name: 'attempt', facts: { 'serve.candidate': { upstream: { id: 'loser' } } } });
  recorder.event({ type: 'stage.leaved', stageId: 3, facts: last });
  recorder.event({ type: 'stage.leaved', stageId: 1, facts: first });
  await recorder.finish();

  const archive = decodeDump(contents);
  expect(archive.stages.get(1)?.responseFacts).toBe(archive.stages.get(2)?.responseFacts);
  expect(archive.stages.get(1)?.responseFacts).not.toBe(archive.stages.get(3)?.responseFacts);
  expect(commit).toHaveBeenCalledWith(expect.objectContaining({ method: 'POST', path: '/v1/chat/completions', status: 429, model: 'winner-model', error: null }), 'winner');
});

test('surfaces encoding failures during finish and leaves the pipeline observer callable', async () => {
  const commit = vi.fn(async () => {});
  const recorder = createPipelineRecorder('key', async (_keyId, _id, bytes) => {
    await new Response(bytes).text();
    return commit;
  });
  expect(() => recorder.event({ type: 'stage.entered', stageId: 1, name: 'serve', facts: { ...request, bad: 1n } })).not.toThrow();
  expect(() => recorder.event({ type: 'stage.leaved', stageId: 1, facts: {} })).not.toThrow();
  await expect(recorder.finish()).rejects.toThrow('Unsupported dump value bigint');
  expect(commit).not.toHaveBeenCalled();
});

test('commits a failed run with its original panic facts', async () => {
  const commit = vi.fn(async () => {});
  let contents = '';
  const recorder = createPipelineRecorder('key', async (_keyId, _id, bytes) => {
    contents = await new Response(bytes).text();
    return commit;
  });
  const error = new Error('upstream failed');
  recorder.event({ type: 'stage.entered', stageId: 1, name: 'serve', facts: request });
  recorder.event({ type: 'stage.panicked', stageId: 1, error, facts: { offset: 5 } });
  await recorder.finish();
  expect(decodeDump(contents).stages.get(1)?.panic).toMatchObject({ error: { message: 'upstream failed' }, facts: { offset: 5 } });
  expect(commit).toHaveBeenCalledWith(expect.objectContaining({ status: null, error: 'upstream failed' }), null);
});

test('reports the original archive write failure during finish', async () => {
  const error = new Error('archive write failed');
  const recorder = createPipelineRecorder('key', async () => { throw error; });
  expect(() => recorder.event({ type: 'stage.entered', stageId: 1, name: 'serve', facts: request })).not.toThrow();
  expect(() => recorder.event({ type: 'stage.leaved', stageId: 1, facts: {} })).not.toThrow();
  await expect(recorder.finish()).rejects.toBe(error);
});

test('measures the first successful frame of the returned stream from root entry', async () => {
  let time = 10;
  const clock = vi.spyOn(performance, 'now').mockImplementation(() => time);
  const commit = vi.fn(async () => {});
  let contents = '';
  const recorder = createPipelineRecorder('key', async (_keyId, _id, bytes) => {
    contents = await new Response(bytes).text();
    return commit;
  });
  const { compose, defineStage } = factSpace<{
    'request.http': typeof request['request.http'];
    'response.http': { status: number; body: ManagedStream<Uint8Array, { readonly cause: Error }> };
  }>();
  const ending = defineStage({
    name: 'serve-stream',
    request: { needs: ['request.http'] },
    return: { provides: ['response.http'] },
    async execute(_facts, scope) {
      const discarded = scope.createStream<Uint8Array, never>(async function* () {
        time = 13;
        yield { ok: true, value: Uint8Array.of(0xff) };
      });
      for await (const _ of discarded) { /* Consume the internal stream. */ }
      const response = scope.createStream<Uint8Array, { readonly cause: Error }>(async function* () {
        time = 34;
        yield { ok: true, value: Uint8Array.of(0x01) };
        time = 46;
        yield { ok: true, value: Uint8Array.of(0x02) };
        time = 50;
        yield { ok: false, error: { cause: new Error('stream interrupted') } };
      });
      return { 'response.http': move({ status: 200, body: response }) };
    },
  });
  const pipeline = compose('stream', { entry: ['request.http'], exit: ['response.http'], stages: [], ending });
  try {
    const handle = run(pipeline, { 'request.http': move(request['request.http']) }, { services: {}, events: recorder.event });
    const answer = await handle.result;
    for await (const _ of answer['response.http'].body) { /* Consume the returned stream. */ }
    await handle.done;
    await recorder.finish();
  } finally {
    clock.mockRestore();
  }
  expect(commit).toHaveBeenCalledWith(expect.objectContaining({ durationMs: 40, ttftMs: 24, requestBytes: 1, responseBytes: 2, error: 'stream interrupted' }), null);
  expect(decodeDump(contents).streams.size).toBe(2);
  expect(contents).not.toContain('ttftMs');
});

test('reads token totals from the selected attempt even after its consumer removes the deferred', async () => {
  const { compose, defineStage } = factSpace<{
    'request.http': typeof request['request.http'];
    'serve.candidate': { readonly upstream: { readonly id: string } };
    'response.http': { readonly status: number; readonly body: Uint8Array };
    'response.usage': Deferred<ComputedUsage>;
  }>();
  const choose = defineStage({
    name: 'serve.failover',
    through: {
      request: { needs: ['request.http'], provides: ['serve.candidate'], consumes: [] },
      response: { needs: ['response.http'], provides: [], consumes: [] },
    },
    async execute(facts, scope) {
      const selected = await scope.next({ ...facts, 'serve.candidate': move({ upstream: { id: 'selected' } }) });
      await scope.next({ ...facts, 'serve.candidate': move({ upstream: { id: 'discarded' } }) });
      return selected;
    },
  });
  const consume = defineStage({
    name: 'serve.store-usage',
    through: {
      request: { needs: ['serve.candidate'], provides: [], consumes: [] },
      response: { needs: ['response.http', 'response.usage'], provides: [], consumes: ['response.usage'] },
    },
    async execute(facts, scope) {
      const { 'response.usage': _usage, ...http } = await scope.next(facts);
      return http;
    },
  });
  const ending = defineStage({
    name: 'serve.compute-usage',
    request: { needs: ['serve.candidate'] },
    return: { provides: ['response.http', 'response.usage'] },
    async execute({ 'serve.candidate': candidate }, scope) {
      const chosen = candidate.upstream.id === 'selected';
      const { deferred, resolve } = scope.deferred<ComputedUsage>();
      resolve(move({
        observation: {
          kind: 'reported',
          measurement: { quantities: {}, pricingFacts: {}, dumpTokenUsage: { input: chosen ? 12 : 88, input_cache_read: 4, output: 9 } },
        },
        row: null,
      }));
      return { 'response.http': move({ status: 200, body: chosen ? Uint8Array.of(0xff, 0x80) : Uint8Array.of(0xff) }), 'response.usage': deferred };
    },
  });
  const pipeline = compose('usage', { entry: ['request.http'], exit: ['response.http'], stages: [choose, consume], ending });
  const commit = vi.fn(async () => {});
  const recorder = createPipelineRecorder('key', async (_keyId, _id, bytes) => {
    await new Response(bytes).text();
    return commit;
  });
  const handle = run(pipeline, { 'request.http': move(request['request.http']) }, { services: {}, events: recorder.event });
  await handle.result;
  await handle.done;
  await recorder.finish();
  expect(commit).toHaveBeenCalledWith(expect.objectContaining({ inputTokens: 16, outputTokens: 9, requestBytes: 1, responseBytes: 2 }), 'selected');
});
