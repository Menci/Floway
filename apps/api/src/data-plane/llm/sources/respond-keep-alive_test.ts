import { type Context, Hono } from 'hono';
import { test } from 'vitest';

import type { RequestContext } from '../interceptors.ts';
import { respondChatCompletions } from './chat-completions/respond.ts';
import { respondGemini } from './gemini/respond.ts';
import { respondMessages } from './messages/respond.ts';
import { respondResponses } from './responses/respond.ts';
import { assertEquals } from '../../../test-assert.ts';
import { FakeTime } from '../../../test-time.ts';
import { eventResult } from '../shared/errors/result.ts';
import { DOWNSTREAM_KEEP_ALIVE_INTERVAL_MS } from '../shared/stream/proxy-sse.ts';
import type { ChatCompletionsStreamEvent } from '@floway-dev/protocols/chat-completions';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import type { GeminiStreamEvent } from '@floway-dev/protocols/gemini';
import type { MessagesStreamEvent } from '@floway-dev/protocols/messages';
import type { RawResponsesStreamEvent } from '@floway-dev/protocols/responses';

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

const deferred = <T>(): Deferred<T> => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(res => {
    resolve = res;
  });

  return { promise, resolve };
};

const closedIteratorResult = <TEvent>(): IteratorResult<ProtocolFrame<TEvent>> => ({
  done: true,
  value: undefined,
});

const createIdleProtocolEvents = <TEvent>() => {
  let pendingNext: Deferred<IteratorResult<ProtocolFrame<TEvent>>> | undefined;
  let returnCalled = false;

  const events: AsyncIterable<ProtocolFrame<TEvent>> = {
    [Symbol.asyncIterator]() {
      return {
        next() {
          pendingNext = deferred<IteratorResult<ProtocolFrame<TEvent>>>();
          return pendingNext.promise;
        },
        return() {
          returnCalled = true;
          pendingNext?.resolve(closedIteratorResult<TEvent>());
          return Promise.resolve(closedIteratorResult<TEvent>());
        },
      };
    },
  };

  return {
    events,
    hasPendingNext: () => pendingNext !== undefined,
    returnCalled: () => returnCalled,
  };
};

const waitForIteratorStart = async (events: ReturnType<typeof createIdleProtocolEvents>) => {
  for (let i = 0; i < 10; i++) {
    if (events.hasPendingNext()) return;
    await Promise.resolve();
  }

  throw new Error('protocol iterator did not start');
};

const requestResponse = async <TEvent>(events: AsyncIterable<ProtocolFrame<TEvent>>, respond: (c: Context, events: AsyncIterable<ProtocolFrame<TEvent>>) => Promise<Response>): Promise<Response> => {
  const app = new Hono();
  app.get('/', c => respond(c, events));
  return await app.request('/');
};

const decodeChunk = (value: Uint8Array | undefined): string => new TextDecoder().decode(value);

const readKeepAliveChunk = async (response: Response, time: FakeTime): Promise<{ reader: ReadableStreamDefaultReader<Uint8Array>; text: string }> => {
  const reader = response.body!.getReader();
  const read = reader.read().then(chunk => (chunk.done ? '<closed>' : decodeChunk(chunk.value)));

  await time.tickAsync(DOWNSTREAM_KEEP_ALIVE_INTERVAL_MS);
  for (let i = 0; i < 10; i++) {
    await Promise.resolve();
    const text = await Promise.race([read, Promise.resolve(null)]);
    if (text !== null) return { reader, text };
  }

  return { reader, text: '<pending>' };
};

const assertSourceKeepAlive = async <TEvent>(respond: (c: Context, events: AsyncIterable<ProtocolFrame<TEvent>>) => Promise<Response>, expected: string) => {
  const time = new FakeTime();
  const idle = createIdleProtocolEvents<TEvent>();

  try {
    const response = await requestResponse(idle.events, respond);
    await waitForIteratorStart(idle);
    const { reader, text } = await readKeepAliveChunk(response, time);

    try {
      assertEquals(text, expected);
    } finally {
      await reader.cancel();
    }
  } finally {
    time.restore();
  }
};

const testTelemetryModelIdentity = {
  model: 'test-model',
  upstream: 'test-upstream',
  modelKey: 'test-model-key', cost: null,
};

const requestStartedAt = performance.now();
const request = (): RequestContext => ({
  requestStartedAt,
  statefulResponsesContext: { privatePayload: new Map(), newSyntheticIds: new Set() },
  runtimeLocation: 'test',
  clientStream: true,
});

test('Messages streaming keepalive uses Anthropic ping events', async () => {
  await assertSourceKeepAlive<MessagesStreamEvent>(async (c, events) => (await respondMessages(c, eventResult(events, testTelemetryModelIdentity), true, request(), undefined)).response, 'event: ping\ndata: {"type":"ping"}\n\n');
});

test('Responses streaming keepalive uses SSE comments', async () => {
  await assertSourceKeepAlive<RawResponsesStreamEvent>(async (c, events) => (await respondResponses(c, eventResult(events, testTelemetryModelIdentity), true, request(), undefined)).response, ': keepalive\n\n');
});

test('Chat Completions streaming keepalive uses SSE comments', async () => {
  await assertSourceKeepAlive<ChatCompletionsStreamEvent>(async (c, events) => (await respondChatCompletions(c, eventResult(events, testTelemetryModelIdentity), true, true, request(), undefined)).response, ': keepalive\n\n');
});

test('Gemini streaming keepalive uses SSE comments', async () => {
  await assertSourceKeepAlive<GeminiStreamEvent>(async (c, events) => (await respondGemini(c, eventResult(events, testTelemetryModelIdentity), true, request(), undefined)).response, ': keepalive\n\n');
});
