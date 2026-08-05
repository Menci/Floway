import { Hono } from 'hono';
import { test } from 'vitest';

import { respondMessages } from '../../../../src/data-plane/chat/messages/respond.ts';
import { createMessagesBillableUsageReader } from '../../../../src/data-plane/chat/messages/usage.ts';
import type { ChatGatewayCtx } from '../../../../src/data-plane/chat/shared/gateway-ctx.ts';
import { providerStreamResultToExecuteResult } from '../../../../src/data-plane/chat/shared/provider-stream-result.ts';
import { initRepo } from '../../../../src/repo/index.ts';
import { tokenCountsFromUsage } from '../../../../src/repo/usage-metrics.ts';
import { InMemoryRepo } from '../../../repo/memory.ts';
import { mockChatGatewayCtx } from '../../../test-utils/gateway-ctx.ts';
import { doneFrame, eventFrame, type ProtocolFrame } from '@floway-dev/protocols/common';
import type { MessagesStreamEvent } from '@floway-dev/protocols/messages';
import { eventResult, type ExecuteResult, type ProviderStreamResult } from '@floway-dev/provider';
import { assert, assertEquals, stubModelCandidate, testTelemetryModelIdentity } from '@floway-dev/test-utils';

// --- header forwarding ---

const forwardedHeadersFixture = (): Headers => new Headers({
  // forwardable: vendor traces, plan billing, vendor `x-*`, arbitrary custom
  'anthropic-ratelimit-unified-status': 'allowed_warning',
  'anthropic-ratelimit-unified-fallback-percentage': '50',
  'request-id': 'req_anthropic_abc',
  'cf-ray': 'cf_ray_xyz',
  'openai-version': '2024-10-21',
  'x-custom-thing': 'ok',
  // blocked: hop-by-hop, body framing, cookies. Distinctive values so we can
  // tell the upstream's header from anything Hono's writers add.
  'connection': 'close',
  'transfer-encoding': 'gzip',
  'content-length': '999',
  'content-encoding': 'br',
  'content-type': 'application/x-upstream-quirk',
  'set-cookie': 'session=secret',
});

const makeRespondCtx = (): ChatGatewayCtx => mockChatGatewayCtx({ apiKeyId: 'key_respond_test' });

const messagesEventsForRespond = (): readonly MessagesStreamEvent[] => [
  {
    type: 'message_start',
    message: {
      id: 'msg_1', type: 'message', role: 'assistant', content: [], model: 'claude-test',
      stop_reason: null, stop_sequence: null,
      usage: { input_tokens: 3, output_tokens: 0 },
    },
  },
  { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hi' } },
  { type: 'content_block_stop', index: 0 },
  { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } },
  { type: 'message_stop' },
];

const messagesProtocolFrames = async function* (): AsyncGenerator<ProtocolFrame<MessagesStreamEvent>> {
  for (const event of messagesEventsForRespond()) yield eventFrame(event);
  yield doneFrame();
};

const callRespond = async (wantsStream: boolean): Promise<Response> => {
  initRepo(new InMemoryRepo());
  const app = new Hono();
  let captured: Response | undefined;
  app.get('/', async c => {
    const result: ExecuteResult<ProtocolFrame<MessagesStreamEvent>> = eventResult(
      messagesProtocolFrames(),
      testTelemetryModelIdentity,
      { headers: forwardedHeadersFixture() },
    );
    const response = await respondMessages(c, result, wantsStream, makeRespondCtx());
    captured = response;
    return response;
  });
  await app.request('/');
  if (!captured) throw new Error('respondMessages did not produce a Response');
  return captured;
};

test('respondMessages forwards upstream headers and strips hop-by-hop / framing / cookie headers on the non-streaming JSON response', async () => {
  const response = await callRespond(false);
  // forwarded verbatim
  assertEquals(response.headers.get('anthropic-ratelimit-unified-status'), 'allowed_warning');
  assertEquals(response.headers.get('anthropic-ratelimit-unified-fallback-percentage'), '50');
  assertEquals(response.headers.get('request-id'), 'req_anthropic_abc');
  assertEquals(response.headers.get('cf-ray'), 'cf_ray_xyz');
  assertEquals(response.headers.get('openai-version'), '2024-10-21');
  assertEquals(response.headers.get('x-custom-thing'), 'ok');
  // hop-by-hop and cookies dropped
  assertEquals(response.headers.get('connection'), null);
  assertEquals(response.headers.get('transfer-encoding'), null);
  assertEquals(response.headers.get('set-cookie'), null);
  // framing headers dropped — upstream values would mis-frame the response;
  // Response.json sets its own content-type, which must not echo upstream's
  assertEquals(response.headers.get('content-length'), null);
  assertEquals(response.headers.get('content-encoding'), null);
  assertEquals(response.headers.get('content-type'), 'application/json');
});

test('respondMessages forwards upstream headers and strips hop-by-hop / framing / cookie headers on the streaming SSE response', async () => {
  const response = await callRespond(true);
  // forwarded verbatim
  assertEquals(response.headers.get('anthropic-ratelimit-unified-status'), 'allowed_warning');
  assertEquals(response.headers.get('anthropic-ratelimit-unified-fallback-percentage'), '50');
  assertEquals(response.headers.get('request-id'), 'req_anthropic_abc');
  assertEquals(response.headers.get('cf-ray'), 'cf_ray_xyz');
  assertEquals(response.headers.get('openai-version'), '2024-10-21');
  assertEquals(response.headers.get('x-custom-thing'), 'ok');
  // hop-by-hop and cookies dropped. `connection` and `transfer-encoding`
  // are special-cased: Hono's streamSSE writer sets its own `keep-alive` /
  // `chunked`, so we assert upstream's distinctive values did not survive
  // rather than asserting absence.
  assert(response.headers.get('connection') !== 'close');
  assert(response.headers.get('transfer-encoding') !== 'gzip');
  assertEquals(response.headers.get('set-cookie'), null);
  // framing headers dropped; streamSSE writes its own text/event-stream and
  // never emits content-length or content-encoding for a streamed body
  assertEquals(response.headers.get('content-length'), null);
  assertEquals(response.headers.get('content-encoding'), null);
  assertEquals(response.headers.get('content-type')?.split(';')[0], 'text/event-stream');
  // Drain the body so the lazy generator releases its resources and the
  // background `finally` block in `streamSSE` doesn't keep the test runner
  // alive.
  await response.text();
});

// --- partial usage checkpointing on client disconnect ---

// A generator whose next() resolves only when emit() supplies the next event.
// Lets a test interleave "upstream emitted frame X" with "downstream cancels",
// so the streaming finally block fires while message_stop is still in flight.

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
}

const deferred = <T>(): Deferred<T> => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(resolvePromise => { resolve = resolvePromise; });
  return { promise, resolve };
};

const controlledMessagesEvents = (signal: AbortSignal): {
  readonly events: AsyncIterable<ProtocolFrame<MessagesStreamEvent>>;
  readonly emit: (event: MessagesStreamEvent) => void;
  readonly stopped: Promise<void>;
} => {
  const queued: ProtocolFrame<MessagesStreamEvent>[] = [];
  let pending: Deferred<IteratorResult<ProtocolFrame<MessagesStreamEvent>>> | undefined;
  const stopped = deferred<void>();
  const events: AsyncIterable<ProtocolFrame<MessagesStreamEvent>> = {
    [Symbol.asyncIterator]() {
      return {
        next(): Promise<IteratorResult<ProtocolFrame<MessagesStreamEvent>>> {
          if (signal.aborted) return Promise.resolve({ done: true, value: undefined });
          const frame = queued.shift();
          if (frame !== undefined) return Promise.resolve({ done: false, value: frame });
          pending = deferred<IteratorResult<ProtocolFrame<MessagesStreamEvent>>>();
          return pending.promise;
        },
        return(): Promise<IteratorResult<ProtocolFrame<MessagesStreamEvent>>> {
          pending?.resolve({ done: true, value: undefined });
          stopped.resolve();
          return Promise.resolve({ done: true, value: undefined });
        },
      };
    },
  };
  signal.addEventListener('abort', () => {
    pending?.resolve({ done: true, value: undefined });
    pending = undefined;
    stopped.resolve();
  }, { once: true });
  return {
    events,
    emit: event => {
      const frame = eventFrame(event);
      if (pending === undefined) queued.push(frame);
      else {
        const waiter = pending;
        pending = undefined;
        waiter.resolve({ done: false, value: frame });
      }
    },
    stopped: stopped.promise,
  };
};

test('respondMessages records the latest upstream usage when the client disconnects before message_stop', async () => {
  const repo = new InMemoryRepo();
  initRepo(repo);
  const downstreamAbortController = new AbortController();
  const controlled = controlledMessagesEvents(downstreamAbortController.signal);
  const scheduledUsage = deferred<Promise<unknown>>();
  const ctx: ChatGatewayCtx = {
    ...makeRespondCtx(),
    wantsStream: true,
    abortSignal: downstreamAbortController.signal,
    downstreamAbortController,
    backgroundScheduler: promise => { scheduledUsage.resolve(promise); },
  };
  const providerResult: ProviderStreamResult<MessagesStreamEvent> = {
    ok: true,
    events: controlled.events,
    modelKey: 'claude-upstream',
  };
  const result = await providerStreamResultToExecuteResult(
    providerResult,
    stubModelCandidate({ model: { id: 'claude-public' } }),
    'messages',
    ctx,
    createMessagesBillableUsageReader(),
  );
  const app = new Hono().get('/', c => respondMessages(c, result, true, ctx));
  const response = await app.request('/');
  const reader = response.body!.getReader();

  controlled.emit({
    type: 'message_start',
    message: {
      id: 'msg_abort', type: 'message', role: 'assistant', content: [], model: 'claude-test',
      stop_reason: null, stop_sequence: null,
      usage: { input_tokens: 20, output_tokens: 0 },
    },
  });
  await reader.read();
  for (const outputTokens of [5, 11, 17]) {
    controlled.emit({ type: 'message_delta', delta: {}, usage: { output_tokens: outputTokens } });
    await reader.read();
  }

  await reader.cancel();
  await controlled.stopped;
  await (await scheduledUsage.promise);

  assertEquals(downstreamAbortController.signal.aborted, true);
  const rows = await repo.usage.listAll();
  assertEquals(rows.length, 1);
  assertEquals(tokenCountsFromUsage(rows[0]), { input: 20, output: 17 });
});
