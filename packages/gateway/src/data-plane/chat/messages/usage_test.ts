import { test } from 'vitest';

import { createMessagesStreamUsageState, tokenUsageFromMessagesFrame } from './usage.ts';
import { eventFrame } from '@floway-dev/protocols/common';
import type { MessagesStreamEvent } from '@floway-dev/protocols/messages';
import { assertEquals } from '@floway-dev/test-utils';

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
