import { expect, test } from 'vitest';

import { collectChatOutcome } from '../../../../src/data-plane/chat/pipeline/collect.ts';
import { factSpace, move, run, type ManagedStream, type Result } from '@floway-dev/pipeline';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import type { ProtocolStreamError } from '@floway-dev/provider';

const { compose, defineStage } = factSpace<{ stream: ManagedStream<string, ProtocolStreamError> }>();

const startSource = async (produce: (signal: AbortSignal) => AsyncIterable<Result<string, ProtocolStreamError>>) => {
  const ending = defineStage({
    name: 'test.return-chat-collection-stream',
    request: { needs: [] },
    return: { provides: ['stream'] },
    async execute(_facts, scope) {
      return { stream: scope.createStream(({ signal }) => produce(signal)) };
    },
  });
  const pipeline = compose('test.chat-collection-stream', { entry: [], exit: ['stream'], stages: [], ending });
  const controller = new AbortController();
  const handle = run(pipeline, {}, { services: {}, signal: controller.signal });
  return {
    ...(await handle.result),
    done: handle.done,
    abort: () => { controller.abort(); },
  };
};

const formatError = (message: string) => ({ error: { message } });
const emptyResult = async (frames: AsyncIterable<ProtocolFrame<string>>) => {
  for await (const _ of frames) {
    // The test only checks whether collection reached its terminal outcome.
  }
  return {};
};

test('chat collection reads each frame on demand and drains after an early result', async () => {
  const aborted = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let drained = false;
  const source = await startSource(async function* (signal) {
    yield { ok: true, value: 'first' };
    expect(signal.aborted).toBe(true);
    aborted.resolve();
    await release.promise;
    yield { ok: true, value: 'discarded' };
    drained = true;
  });
  const result = collectChatOutcome(source.stream, source, async frames => {
    for await (const frame of frames) {
      expect(frame).toEqual({ type: 'event', event: 'first' });
      expect(drained).toBe(false);
      return frame;
    }
    throw new Error('Expected the first frame');
  }, formatError);
  try {
    await Promise.race([aborted.promise, result.then(() => { throw new Error('Collection returned before abort'); })]);
    expect(drained).toBe(false);
  } finally {
    release.resolve();
  }
  expect(await result).toEqual({ kind: 'result', result: { type: 'event', event: 'first' } });
  await source.done;
  expect(drained).toBe(true);
});

test.each([
  { limits: { bytes: 1, frames: 10 }, values: ['界'], accepted: 0, message: 'Chat response collection exceeded 1 bytes' },
  { limits: { bytes: 1024, frames: 1 }, values: ['one', 'two'], accepted: 1, message: 'Chat response collection exceeded 1 frames' },
])('chat collection reports a local error when its budget overflows', async ({ limits, values, accepted, message }) => {
  let drained = false;
  const source = await startSource(async function* (signal) {
    for (const value of values) yield { ok: true, value };
    expect(signal.aborted).toBe(true);
    drained = true;
  });
  let seen = 0;
  const outcome = await collectChatOutcome(source.stream, source, async frames => {
    for await (const _ of frames) seen++;
    return {};
  }, formatError, limits);
  expect(seen).toBe(accepted);
  expect(outcome).toMatchObject({ kind: 'error', source: 'local', error: { error: { message } }, cause: expect.any(RangeError) });
  await source.done;
  expect(drained).toBe(true);
});

test('chat collection keeps the original upstream stream failure as its cause', async () => {
  const failure = move({ kind: 'transport', cause: new Error('connection dropped') } as const);
  const source = await startSource(async function* (signal) {
    yield { ok: false, error: failure };
    expect(signal.aborted).toBe(true);
  });
  const outcome = await collectChatOutcome(source.stream, source, emptyResult, formatError);
  expect(outcome).toEqual({
    kind: 'error', source: 'upstream', error: { error: { message: 'connection dropped' } }, cause: failure,
  });
  await source.done;
});
