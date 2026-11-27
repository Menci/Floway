import { expect, test, vi } from 'vitest';

import { chatSse } from '../../../src/data-plane/chat/pipeline/encode.ts';
import { servePipelineHttp } from '../../../src/data-plane/shared/pipeline-http.ts';
import { DOWNSTREAM_KEEP_ALIVE_INTERVAL_MS, serializeSseFrame } from '../../../src/data-plane/shared/sse.ts';
import { hostFor } from '../pipeline/fixtures.ts';
import type { HttpResponseFact } from '@floway-dev/http';
import { asEntry, factSpace, type ManagedStream, type Result } from '@floway-dev/pipeline';
import { sseFrame } from '@floway-dev/protocols/common';
import type { ProtocolStreamError } from '@floway-dev/upstream';

type Source = ManagedStream<string, ProtocolStreamError>;
type Events = AsyncGenerator<Result<string, ProtocolStreamError>, void, unknown>;

const serveChat = (events: (signal: AbortSignal) => Events) => {
  const error = vi.fn(() => [{ wire: sseFrame('failure') }]);
  const host = hostFor({ dump: null });
  const { defineStage, compose } = factSpace<object, { http: HttpResponseFact; source: Source }, { dump: null }>();
  const ending = defineStage({
    name: 'chat-source',
    request: { needs: [] },
    return: { provides: ['http', 'source'] },
    async execute(_facts, scope) {
      return {
        http: { status: 200, statusText: '', headers: [], body: null },
        source: scope.createStream(({ signal }) => events(signal)),
      };
    },
  });
  const encode = defineStage({
    name: 'chat-sse',
    through: {
      request: { needs: [], provides: [], consumes: [] },
      response: { needs: ['http', 'source'], provides: ['http'], consumes: ['source'] },
    },
    async execute(facts, scope) {
      const { source, http, ...answer } = await scope.next(facts);
      return {
        ...answer,
        http: chatSse(http, source, scope, {
          protocol: 'openaiChatCompletions',
          event: data => ({ wire: sseFrame(data) }),
          error,
        }),
      };
    },
  });
  const entry = asEntry(compose('chat', { entry: [], exit: ['http'], stages: [encode], ending }));
  return { host, error, response: servePipelineHttp(entry, {}, host.options) };
};

const bytes = (value: string): Uint8Array => new TextEncoder().encode(value);

test('chat SSE emits idle keepalives while keeping one source read pending', async () => {
  vi.useFakeTimers();
  try {
    const resume = Promise.withResolvers<void>();
    const pull = vi.fn();
    const { host, response } = serveChat(async function* () {
      pull();
      await resume.promise;
      yield { ok: true, value: 'ready' };
    });
    const reader = (await response).body!.getReader();
    for (let heartbeat = 0; heartbeat < 2; heartbeat++) {
      const reading = reader.read();
      await vi.advanceTimersByTimeAsync(DOWNSTREAM_KEEP_ALIVE_INTERVAL_MS);
      await expect(reading).resolves.toEqual({ done: false, value: bytes(': keepalive\n\n') });
      expect(pull).toHaveBeenCalledOnce();
    }
    resume.resolve();
    await expect(reader.read()).resolves.toEqual({ done: false, value: bytes('data: ready\n\n') });
    await expect(reader.read()).resolves.toEqual({ done: true, value: undefined });
    await host.settle();
    expect(vi.getTimerCount()).toBe(0);
    expect(host.errors).toEqual([]);
  } finally {
    vi.useRealTimers();
  }
});

test('canceling an idle chat response aborts and releases its pending source read', async () => {
  const opened = Promise.withResolvers<AbortSignal>();
  const sourceClosed = vi.fn();
  const reason = new Error('test client disconnected');
  const { host, error, response } = serveChat(async function* (signal) {
    opened.resolve(signal);
    try {
      await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }));
      yield { ok: false, error: { kind: 'abort', cause: signal.reason } };
    } finally {
      sourceClosed();
    }
  });
  const reader = (await response).body!.getReader();
  const reading = reader.read();
  const signal = await opened.promise;
  await reader.cancel(reason);
  expect(signal.reason).toBe(reason);
  await expect(reading).resolves.toEqual({ done: true, value: undefined });
  await host.settle();
  expect(sourceClosed).toHaveBeenCalledOnce();
  expect(error).not.toHaveBeenCalled();
  expect(host.errors).toEqual([]);
});

test('SSE serialization preserves raw frames and separates lines of a named event', () => {
  expect(serializeSseFrame({ type: 'sse-raw', data: ': raw\n\n' })).toBe(': raw\n\n');
  expect(serializeSseFrame({ type: 'sse', event: 'delta', data: 'one\r\ntwo\rthree\nfour' }))
    .toBe('event: delta\ndata: one\ndata: two\ndata: three\ndata: four\n\n');
});
