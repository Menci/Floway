import { expect, it } from 'vitest';

import { createDumpDecoder, getStreamLineage, isDecodedDeferredRef, isDecodedStreamRef, projectWireExchanges } from '../src/browser.ts';
import { createDumpPump } from '../src/pump.ts';
import type { Deferred, ManagedStream } from '@floway-dev/pipeline';
import { Bytes, compose, defineEnding, run } from '@floway-dev/pipeline';

it('records a real pipeline with a run-owned stream, a wrapper, and a deferred settlement', async () => {
  type Input = { readonly body: ManagedStream<Bytes> };
  type Output = { readonly body: ManagedStream<Bytes>; readonly usage: Deferred<number> };
  const ending = defineEnding<Input, Output>({
    name: 'wrapBody',
    request: { needs: ['body'] },
    return: { provides: ['body', 'usage'] },
    execute: async ({ body }, _into, env) => {
      const wrapped = env.wrapStream(body, {
        label: 'wrapped',
        transform: source => source,
        onClose: (): void => usage.resolve(2),
      });
      const usage = env.deferred<number>('usage', wrapped);
      return { body: wrapped, usage: usage.deferred };
    },
  });
  const pipeline = compose<Input, Output, {}>('dump-fixture', { stages: [], ending });
  const pump = createDumpPump();
  const decoder = createDumpDecoder();
  const decode = pump.artifact.pipeTo(new WritableStream({ write: bytes => { decoder.push(bytes); } }));
  const handle = run(pipeline, root => ({
    body: root.createStream({
      label: 'input',
      async *iterate() {
        yield Bytes.fromUtf8('hello');
        yield Bytes.fromUtf8('world');
      },
    }),
  }), { services: {}, events: pump.sink, finalizationTimeoutMs: 1_000 });

  const { body, usage } = await handle.result;
  const delivered: string[] = [];
  for await (const chunk of body) delivered.push(chunk.utf8());
  expect(delivered).toEqual(['hello', 'world']);
  await expect(usage.promise).resolves.toBe(2);
  await expect(handle.done).resolves.toEqual({ ok: true });
  await Promise.all([pump.completed, decode]);

  const model = decoder.finish();
  expect(model.run).toMatchObject({ pipeline: 'dump-fixture', done: { ok: true } });
  const stage = model.stages.get(model.rootStageIds[0])!;
  expect(stage).toMatchObject({ name: 'wrapBody', status: 'succeeded' });
  const inputRef = stage.facts.body;
  const outputRef = stage.responseFacts?.body;
  const usageRef = stage.responseFacts?.usage;
  if (!isDecodedStreamRef(inputRef) || !isDecodedStreamRef(outputRef) || !isDecodedDeferredRef(usageRef))
    throw new Error('Expected stream and deferred references');
  const input = model.streams.get(inputRef.$stream)!;
  const output = model.streams.get(outputRef.$stream)!;
  expect(stage.createdStreamIds).toEqual([input.streamId, output.streamId]);
  expect(getStreamLineage(model, output.streamId)).toEqual([input.streamId, output.streamId]);
  expect(output.frames).toHaveLength(2);
  expect(output.frames[0].value).toBe(input.frames[0].value);
  expect(output.frames[1].value).toBe(input.frames[1].value);
  expect(output.end?.how).toBe('exhausted');
  expect(model.deferreds.get(usageRef.$deferred)?.settlement).toMatchObject({ ok: true, value: 2 });
});

it('round-trips both merge edges and projects only the merged body onto the wire', async () => {
  type Input = { readonly a: ManagedStream<Bytes>; readonly b: ManagedStream<Bytes> };
  type WireResponse = {
    readonly status: number;
    readonly statusText: string;
    readonly headers: readonly [];
    readonly body: ManagedStream<Bytes>;
    readonly timing: { readonly startedAt: number; readonly headersAt: number };
  };
  type Output = { readonly 'response.http': WireResponse };
  const ending = defineEnding<Input, Output>({
    name: 'mergeBody', request: { needs: ['a', 'b'] }, return: { provides: ['response.http'] },
    execute: async ({ a, b }, _into, env) => {
      const body = env.wrapStream({ a, b }, {
        label: 'merged', async *transform(sources) {
          const [first, second] = await Promise.all([sources.a[Symbol.asyncIterator]().next(), sources.b[Symbol.asyncIterator]().next()]);
          if (!first.done && !second.done) yield Bytes.concat([first.value, second.value]);
        },
      });
      return { 'response.http': { status: 200, statusText: 'OK', headers: [], body, timing: { startedAt: 0, headersAt: 1 } } };
    },
  });
  const pipeline = compose<Input, Output, {}>('merge', { stages: [], ending });
  const pump = createDumpPump();
  const decoder = createDumpDecoder();
  const decode = pump.artifact.pipeTo(new WritableStream({ write: bytes => { decoder.push(bytes); } }));
  const handle = run(pipeline, root => ({
    a: root.createStream({ label: 'a', async *iterate() { yield Bytes.fromUtf8('a'); } }),
    b: root.createStream({ label: 'b', async *iterate() { yield Bytes.fromUtf8('b'); } }),
  }), { services: {}, events: pump.sink, finalizationTimeoutMs: 1_000 });
  const { 'response.http': { body } } = await handle.result;
  expect((await Array.fromAsync(body)).map(chunk => chunk.utf8())).toEqual(['ab']);
  await expect(handle.done).resolves.toEqual({ ok: true });
  await Promise.all([pump.completed, decode]);

  const model = decoder.finish();
  const [a, b, merge] = model.streams.values();
  expect(merge.wraps).toEqual([a.streamId, b.streamId]);
  expect(a.derivedStreamIds).toEqual([merge.streamId]);
  expect(b.derivedStreamIds).toEqual([merge.streamId]);
  expect(getStreamLineage(model, merge.streamId)).toEqual([a.streamId, b.streamId, merge.streamId]);
  const response = projectWireExchanges(model).downstreamResponse;
  expect(response?.stream).toBe(merge);
  expect(response?.stream?.frames.map(frame => frame.value instanceof Bytes && frame.value.utf8())).toEqual(['ab']);
});
