import { expect, test, vi } from 'vitest';

import { chatSse } from '../../../../src/data-plane/chat/shared/encode.ts';
import type { GatewayServices } from '../../../../src/data-plane/pipeline/services.ts';
import { DOWNSTREAM_KEEP_ALIVE_INTERVAL_MS } from '../../../../src/data-plane/shared/sse.ts';
import { getHeader, type HttpResponseFact } from '@floway-dev/http';
import { factSpace, run, type ManagedStream, type Result } from '@floway-dev/pipeline';
import { sseFrame } from '@floway-dev/protocols/common';
import type { ProtocolStreamError } from '@floway-dev/provider';

type TestFacts = {
  'response.source': ManagedStream<string, ProtocolStreamError>;
  'response.http': HttpResponseFact;
};

const { compose, defineStage } = factSpace<TestFacts, GatewayServices>();
const text = new TextDecoder();

const start = async (source: () => AsyncGenerator<Result<string, ProtocolStreamError>>) => {
  const pipeline = compose('SSE fixture', {
    entry: [],
    exit: ['response.http'],
    stages: [defineStage({
      name: 'SSE framing',
      through: {
        request: { needs: [], provides: [], consumes: [] },
        response: { needs: ['response.source'], provides: ['response.http'], consumes: ['response.source'] },
      },
      async execute(facts, scope) {
        const { 'response.source': input, ...answer } = await scope.next(facts);
        return {
          ...answer,
          'response.http': chatSse({ status: 201, statusText: 'Created', headers: [['x-upstream', 'trace']] }, input, scope, {
            event: value => sseFrame(value, 'chunk'),
            error: failure => sseFrame(String(failure.cause), 'error'),
            done: sseFrame('[DONE]'),
          }),
        };
      },
    })],
    ending: defineStage({
      name: 'SSE source fixture',
      request: { needs: [] },
      return: { provides: ['response.source'] },
      async execute(_facts, scope) {
        return { 'response.source': scope.createStream(source) };
      },
    }),
  });
  const running = run(pipeline, {}, { services: {} as GatewayServices, signal: new AbortController().signal, waitUntil() {} });
  const { 'response.http': http } = await running.result;
  if (!http.body || http.body instanceof Uint8Array) throw new Error('Expected a byte stream');
  const cursor = running.read(http.body);
  return {
    http,
    done: running.done,
    async next(): Promise<string | undefined> {
      const step = await cursor.next();
      if (step.done) return undefined;
      if (!step.value.ok) throw step.value.error.cause;
      return text.decode(step.value.value);
    },
  };
};

test('emits repeated heartbeats while one upstream read remains pending', async () => {
  vi.useFakeTimers();
  try {
    const release = Promise.withResolvers<void>();
    let reads = 0;
    const running = await start(async function* () {
      reads++;
      await release.promise;
      yield { ok: true, value: 'line 1\r\nline 2' };
    });
    expect(running.http.status).toBe(201);
    expect(getHeader(running.http.headers, 'x-upstream')).toBe('trace');
    expect(getHeader(running.http.headers, 'x-accel-buffering')).toBe('no');
    expect(getHeader(running.http.headers, 'content-type')).toBe('text/event-stream');

    for (let index = 0; index < 2; index++) {
      const pending = running.next();
      await vi.advanceTimersByTimeAsync(DOWNSTREAM_KEEP_ALIVE_INTERVAL_MS);
      await expect(pending).resolves.toBe(': keepalive\n\n');
      expect(reads).toBe(1);
    }
    release.resolve();
    await expect(running.next()).resolves.toBe('event: chunk\ndata: line 1\ndata: line 2\n\n');
    await expect(running.next()).resolves.toBe('data: [DONE]\n\n');
    await expect(running.next()).resolves.toBeUndefined();
    await running.done;
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    vi.useRealTimers();
  }
});

test('renders a source Err once before native done and drains the source', async () => {
  const drained = Promise.withResolvers<void>();
  const running = await start(async function* () {
    yield { ok: false, error: { kind: 'transport', cause: new Error('socket dropped') } };
    drained.resolve();
  });

  await expect(running.next()).resolves.toBe('event: error\ndata: Error: socket dropped\n\n');
  await expect(running.next()).resolves.toBeUndefined();
  await running.done;
  await drained.promise;
});

test('propagates a producer panic with its original cause', async () => {
  const failure = new Error('upstream producer defect');
  const running = await start(async function* () { throw failure; });
  await expect(running.next()).rejects.toBe(failure);
  await expect(running.done).rejects.toBe(failure);
});
