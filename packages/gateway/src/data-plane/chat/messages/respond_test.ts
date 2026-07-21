import { Hono } from 'hono';
import { test } from 'vitest';

import { createMessagesStreamUsageState, respondMessages, tokenUsageFromMessagesFrame } from './respond.ts';
import { initRepo } from '../../../repo/index.ts';
import { InMemoryRepo } from '../../../repo/memory.ts';
import { tokenCountsFromUsage } from '../../../repo/usage-metrics.ts';
import { mockChatGatewayCtx } from '../../../test-helpers/gateway-ctx.ts';
import type { ChatGatewayCtx } from '../shared/gateway-ctx.ts';
import { doneFrame, eventFrame, type ProtocolFrame } from '@floway-dev/protocols/common';
import type { MessagesStreamEvent } from '@floway-dev/protocols/messages';
import { eventResult, type ExecuteResult } from '@floway-dev/provider';
import { assert, assertEquals, testTelemetryModelIdentity } from '@floway-dev/test-utils';

const stop = () => eventFrame({ type: 'message_stop' } satisfies MessagesStreamEvent);

test('Messages stream usage keeps start input and delta output', () => {
  const state = createMessagesStreamUsageState();

  // Every revising frame returns the running snapshot so the observer can
  // checkpoint partial usage into SourceStreamState before the terminal
  // message_stop — required for billing fidelity when the client disconnects
  // mid-stream.
  assertEquals(
    tokenUsageFromMessagesFrame(
      eventFrame({
        type: 'message_start',
        message: {
          id: 'msg_1',
          type: 'message',
          role: 'assistant',
          content: [],
          model: 'claude-test',
          stop_reason: null,
          stop_sequence: null,
          usage: {
            input_tokens: 12,
            output_tokens: 1,
            cache_creation_input_tokens: 4,
            cache_read_input_tokens: 3,
          },
        },
      } satisfies MessagesStreamEvent),
      state,
    ),
    {
      input: 12,
      input_cache_read: 3,
      input_cache_write: 4,
      output: 1,
    },
  );
  assertEquals(
    tokenUsageFromMessagesFrame(
      eventFrame({
        type: 'message_delta',
        delta: {},
        usage: { output_tokens: 7 },
      } satisfies MessagesStreamEvent),
      state,
    ),
    {
      input: 12,
      input_cache_read: 3,
      input_cache_write: 4,
      output: 7,
    },
  );

  assertEquals(tokenUsageFromMessagesFrame(stop(), state), {
    input: 12,
    input_cache_read: 3,
    input_cache_write: 4,
    output: 7,
  });
});

test('Messages stream usage can recover input from delta', () => {
  const state = createMessagesStreamUsageState();

  tokenUsageFromMessagesFrame(
    eventFrame({
      type: 'message_start',
      message: {
        id: 'msg_1',
        type: 'message',
        role: 'assistant',
        content: [],
        model: 'claude-test',
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    } satisfies MessagesStreamEvent),
    state,
  );
  tokenUsageFromMessagesFrame(
    eventFrame({
      type: 'message_delta',
      delta: {},
      usage: {
        input_tokens: 11,
        output_tokens: 2,
        cache_creation_input_tokens: 7,
        cache_read_input_tokens: 5,
      },
    } satisfies MessagesStreamEvent),
    state,
  );
  tokenUsageFromMessagesFrame(
    eventFrame({
      type: 'message_delta',
      delta: {},
      usage: { output_tokens: 6 },
    } satisfies MessagesStreamEvent),
    state,
  );

  assertEquals(tokenUsageFromMessagesFrame(stop(), state), {
    input: 11,
    input_cache_read: 5,
    input_cache_write: 7,
    output: 6,
  });
});

test('Messages stream usage keeps cache-only start when a later delta carries input', () => {
  // A fully cache-hit prompt: message_start reports bare input 0 but non-zero
  // cache reads. A subsequent delta carries input_tokens, which must not cause
  // the start's cache counts to be dropped.
  const state = createMessagesStreamUsageState();

  tokenUsageFromMessagesFrame(
    eventFrame({
      type: 'message_start',
      message: {
        id: 'msg_1',
        type: 'message',
        role: 'assistant',
        content: [],
        model: 'claude-test',
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 1, cache_read_input_tokens: 1000 },
      },
    } satisfies MessagesStreamEvent),
    state,
  );
  tokenUsageFromMessagesFrame(
    eventFrame({
      type: 'message_delta',
      delta: {},
      usage: { input_tokens: 0, output_tokens: 50 },
    } satisfies MessagesStreamEvent),
    state,
  );

  assertEquals(tokenUsageFromMessagesFrame(stop(), state), {
    input_cache_read: 1000,
    output: 50,
  });
});

test('Messages stream usage splits cache_creation per-TTL when the sub-object is present', () => {
  const state = createMessagesStreamUsageState();

  tokenUsageFromMessagesFrame(
    eventFrame({
      type: 'message_start',
      message: {
        id: 'msg_1',
        type: 'message',
        role: 'assistant',
        content: [],
        model: 'claude-opus-4-8',
        stop_reason: null,
        stop_sequence: null,
        usage: {
          input_tokens: 12,
          output_tokens: 1,
          // The flat field is the sum of both sub-buckets and is consulted
          // only as a fallback. With the sub-object present the per-TTL split
          // must take precedence — otherwise this row would double-count.
          cache_creation_input_tokens: 9,
          cache_creation: { ephemeral_5m_input_tokens: 4, ephemeral_1h_input_tokens: 5 },
          cache_read_input_tokens: 3,
        },
      },
    } satisfies MessagesStreamEvent),
    state,
  );

  assertEquals(tokenUsageFromMessagesFrame(stop(), state), {
    input: 12,
    input_cache_read: 3,
    input_cache_write: 4,
    input_cache_write_1h: 5,
    output: 1,
  });
});

test('Messages stream usage falls back to the rolled-up cache_creation when the sub-object is absent', () => {
  const state = createMessagesStreamUsageState();

  tokenUsageFromMessagesFrame(
    eventFrame({
      type: 'message_start',
      message: {
        id: 'msg_1',
        type: 'message',
        role: 'assistant',
        content: [],
        model: 'claude-sonnet-4-6',
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 12, output_tokens: 1, cache_creation_input_tokens: 9, cache_read_input_tokens: 3 },
      },
    } satisfies MessagesStreamEvent),
    state,
  );

  assertEquals(tokenUsageFromMessagesFrame(stop(), state), {
    input: 12,
    input_cache_read: 3,
    input_cache_write: 9,
    output: 1,
  });
});

test('Messages stream usage applies a TTL breakdown restamped by message_delta', () => {
  const state = createMessagesStreamUsageState();
  tokenUsageFromMessagesFrame(
    eventFrame({
      type: 'message_start',
      message: {
        id: 'msg_1',
        type: 'message',
        role: 'assistant',
        content: [],
        model: 'claude-test',
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 12, output_tokens: 0, cache_creation_input_tokens: 9 },
      },
    } satisfies MessagesStreamEvent),
    state,
  );
  tokenUsageFromMessagesFrame(
    eventFrame({
      type: 'message_delta',
      delta: { stop_reason: 'end_turn' },
      usage: {
        output_tokens: 2,
        cache_creation: { ephemeral_1h_input_tokens: 5 },
      },
    } satisfies MessagesStreamEvent),
    state,
  );

  assertEquals(tokenUsageFromMessagesFrame(stop(), state), {
    input: 12,
    input_cache_write: 4,
    input_cache_write_1h: 5,
    output: 2,
  });
});

test('Messages stream usage captures speed=fast as tier=fast', () => {
  const state = createMessagesStreamUsageState();

  tokenUsageFromMessagesFrame(
    eventFrame({
      type: 'message_start',
      message: {
        id: 'msg_1',
        type: 'message',
        role: 'assistant',
        content: [],
        model: 'claude-opus-4-8',
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 5, output_tokens: 0, speed: 'fast' },
      },
    } satisfies MessagesStreamEvent),
    state,
  );

  assertEquals(tokenUsageFromMessagesFrame(stop(), state), {
    input: 5,
    tier: 'fast',
  });
});

test('Messages stream usage leaves tier unset when speed is standard', () => {
  const state = createMessagesStreamUsageState();

  tokenUsageFromMessagesFrame(
    eventFrame({
      type: 'message_start',
      message: {
        id: 'msg_1',
        type: 'message',
        role: 'assistant',
        content: [],
        model: 'claude-opus-4-8',
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 5, output_tokens: 0, speed: 'standard' },
      },
    } satisfies MessagesStreamEvent),
    state,
  );

  assertEquals(tokenUsageFromMessagesFrame(stop(), state), {
    input: 5,
  });
});

test('Messages stream usage forwards service_tier=priority verbatim', () => {
  const state = createMessagesStreamUsageState();

  tokenUsageFromMessagesFrame(
    eventFrame({
      type: 'message_start',
      message: {
        id: 'msg_1',
        type: 'message',
        role: 'assistant',
        content: [],
        model: 'claude-sonnet-4-6',
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 5, output_tokens: 0, service_tier: 'priority' },
      },
    } satisfies MessagesStreamEvent),
    state,
  );

  assertEquals(tokenUsageFromMessagesFrame(stop(), state), {
    input: 5,
    tier: 'priority',
  });
});

test('Messages stream usage forwards service_tier=batch verbatim', () => {
  const state = createMessagesStreamUsageState();

  tokenUsageFromMessagesFrame(
    eventFrame({
      type: 'message_start',
      message: {
        id: 'msg_1',
        type: 'message',
        role: 'assistant',
        content: [],
        model: 'claude-sonnet-4-6',
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 5, output_tokens: 0, service_tier: 'batch' },
      },
    } satisfies MessagesStreamEvent),
    state,
  );

  assertEquals(tokenUsageFromMessagesFrame(stop(), state), {
    input: 5,
    tier: 'batch',
  });
});

test('Messages stream usage forwards an unknown non-standard tier verbatim (forward-compat)', () => {
  // A future Anthropic value the SDK has not minted yet must reach the
  // billing record so the operator can backfill a pricing override for it
  // rather than have it silently fold into the base bucket.
  const state = createMessagesStreamUsageState();

  tokenUsageFromMessagesFrame(
    eventFrame({
      type: 'message_start',
      message: {
        id: 'msg_1',
        type: 'message',
        role: 'assistant',
        content: [],
        model: 'claude-opus-4-8',
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 5, output_tokens: 0, speed: 'turbo' },
      },
    } satisfies MessagesStreamEvent),
    state,
  );

  assertEquals(tokenUsageFromMessagesFrame(stop(), state), {
    input: 5,
    tier: 'turbo',
  });
});

test('Messages stream usage prefers speed=fast over service_tier=standard', () => {
  // Anthropic stamps both fields on a Priority-Tier-aware account; fast mode
  // is mutually exclusive with priority/batch per docs, so a `fast` row will
  // always pair with `service_tier: 'standard'`. The non-standard signal
  // wins; the redundant 'standard' must not clobber it.
  const state = createMessagesStreamUsageState();

  tokenUsageFromMessagesFrame(
    eventFrame({
      type: 'message_start',
      message: {
        id: 'msg_1',
        type: 'message',
        role: 'assistant',
        content: [],
        model: 'claude-opus-4-8',
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 5, output_tokens: 0, speed: 'fast', service_tier: 'standard' },
      },
    } satisfies MessagesStreamEvent),
    state,
  );

  assertEquals(tokenUsageFromMessagesFrame(stop(), state), {
    input: 5,
    tier: 'fast',
  });
});

test('Messages stream usage carries tier forward when a fully cache-hit start is followed by a delta that re-supplies input', () => {
  // A fully cache-hit prompt: message_start reports bare input 0 and tier 'fast',
  // and a later delta carries input_tokens without re-stamping the tier fields.
  // The delta replaces state.current (gotInputFromStart was false), so without
  // explicit carry-forward the fast tier would be dropped — and the row would
  // bill at base.
  const state = createMessagesStreamUsageState();

  tokenUsageFromMessagesFrame(
    eventFrame({
      type: 'message_start',
      message: {
        id: 'msg_1',
        type: 'message',
        role: 'assistant',
        content: [],
        model: 'claude-opus-4-8',
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0, speed: 'fast' },
      },
    } satisfies MessagesStreamEvent),
    state,
  );
  tokenUsageFromMessagesFrame(
    eventFrame({
      type: 'message_delta',
      delta: {},
      usage: { input_tokens: 11, output_tokens: 2, cache_read_input_tokens: 5 },
    } satisfies MessagesStreamEvent),
    state,
  );

  assertEquals(tokenUsageFromMessagesFrame(stop(), state), {
    input: 11,
    input_cache_read: 5,
    output: 2,
    tier: 'fast',
  });
});

test('Messages stream usage lets a delta-stamped tier win over message_start on the cache-hit-prompt path', () => {
  // The wire schema permits message_delta.usage to carry service_tier/speed
  // (packages/protocols/src/messages/index.ts). If a future upstream reassigns
  // the served tier between message_start and message_delta — or starts
  // stamping the served tier only on the delta — the delta value describes
  // the billing bucket and must replace the start-stamped one.
  const state = createMessagesStreamUsageState();

  tokenUsageFromMessagesFrame(
    eventFrame({
      type: 'message_start',
      message: {
        id: 'msg_1',
        type: 'message',
        role: 'assistant',
        content: [],
        model: 'claude-opus-4-8',
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0, speed: 'fast' },
      },
    } satisfies MessagesStreamEvent),
    state,
  );
  tokenUsageFromMessagesFrame(
    eventFrame({
      type: 'message_delta',
      delta: {},
      usage: { input_tokens: 11, output_tokens: 2, service_tier: 'priority' },
    } satisfies MessagesStreamEvent),
    state,
  );

  assertEquals(tokenUsageFromMessagesFrame(stop(), state), {
    input: 11,
    output: 2,
    tier: 'priority',
  });
});

test('Messages stream usage lets a delta-stamped tier win on the normal output-only path', () => {
  // Symmetric to the cache-hit branch: when message_start already carried the
  // real input accounting (gotInputFromStart === true), the delta normally
  // just updates the running output. The wire schema still permits the delta
  // to (re)stamp service_tier/speed, and that signal describes this billing
  // bucket — must replace what start stamped, not be silently dropped.
  const state = createMessagesStreamUsageState();

  tokenUsageFromMessagesFrame(
    eventFrame({
      type: 'message_start',
      message: {
        id: 'msg_1',
        type: 'message',
        role: 'assistant',
        content: [],
        model: 'claude-opus-4-8',
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 50, output_tokens: 0, service_tier: 'standard' },
      },
    } satisfies MessagesStreamEvent),
    state,
  );
  tokenUsageFromMessagesFrame(
    eventFrame({
      type: 'message_delta',
      delta: {},
      usage: { output_tokens: 7, service_tier: 'priority' },
    } satisfies MessagesStreamEvent),
    state,
  );

  assertEquals(tokenUsageFromMessagesFrame(stop(), state), {
    input: 50,
    output: 7,
    tier: 'priority',
  });
});

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
    const { response } = await respondMessages(c, result, wantsStream, makeRespondCtx());
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

interface ControlledEvents {
  events: AsyncIterable<ProtocolFrame<MessagesStreamEvent>>;
  emit: (event: MessagesStreamEvent) => void;
}

// A generator whose next() resolves only when emit() supplies the next event.
// Lets a test interleave "upstream emitted frame X" with "downstream cancels",
// so the streaming finally block fires while message_stop is still in flight.
const controlledMessagesEvents = (): ControlledEvents => {
  const queue: Array<MessagesStreamEvent> = [];
  const waiters: Array<(value: MessagesStreamEvent) => void> = [];
  const events: AsyncIterable<ProtocolFrame<MessagesStreamEvent>> = (async function* () {
    while (true) {
      const event = queue.shift() ?? (await new Promise<MessagesStreamEvent>(resolve => waiters.push(resolve)));
      yield eventFrame(event);
      if (event.type === 'message_stop') return;
    }
  })();
  return {
    events,
    emit: event => {
      const waiter = waiters.shift();
      if (waiter) waiter(event);
      else queue.push(event);
    },
  };
};

test('respondMessages records the last observed message_delta usage when the client disconnects mid-stream', async () => {
  const repo = new InMemoryRepo();
  initRepo(repo);
  const controlled = controlledMessagesEvents();
  const app = new Hono();
  app.get('/', c => {
    const result: ExecuteResult<ProtocolFrame<MessagesStreamEvent>> = eventResult(
      controlled.events,
      testTelemetryModelIdentity,
      { headers: new Headers({ 'content-type': 'text/event-stream' }) },
    );
    const downstreamAbortController = new AbortController();
    const ctx: ChatGatewayCtx = { ...makeRespondCtx(), wantsStream: true, downstreamAbortController };
    return respondMessages(c, result, true, ctx).then(({ response }) => response);
  });
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
  controlled.emit({ type: 'message_delta', delta: {}, usage: { output_tokens: 5 } });
  await reader.read();
  controlled.emit({ type: 'message_delta', delta: {}, usage: { output_tokens: 11 } });
  await reader.read();
  controlled.emit({ type: 'message_delta', delta: {}, usage: { output_tokens: 17 } });
  await reader.read();

  // Disconnect before message_stop. The streamSSE finally block must still
  // record the latest message_delta's output count.
  await reader.cancel();

  // `recordTokenUsage` on InMemoryRepo is synchronous, but the finally block
  // runs after cancellation propagates through streamSSE. Poll briefly to
  // cover that hand-off without coupling to a fixed schedule. The cap is
  // generous so it survives CI contention; the healthy path resolves on the
  // first iteration.
  for (let i = 0; i < 200; i++) {
    if ((await repo.usage.listAll()).length > 0) break;
    await new Promise(resolve => setTimeout(resolve, 10));
  }

  const rows = await repo.usage.listAll();
  assertEquals(rows.length, 1);
  assertEquals(tokenCountsFromUsage(rows[0]), { input: 20, output: 17 });
});
