import { test } from 'vitest';

import { recordUpstreamHttpFailure, withUpstreamTelemetry } from './telemetry.ts';
import { initRepo } from '../../../repo/index.ts';
import { InMemoryRepo } from '../../../repo/memory.ts';
import { assertEquals } from '../../../test-assert.ts';
import { stubProvider, stubUpstreamModel } from '../../../test-helpers.ts';
import type { Invocation, RequestContext } from '../interceptors.ts';

interface TelemetryHarness {
  repo: InMemoryRepo;
  background: Promise<unknown>[];
}

const setup = (): TelemetryHarness => {
  const repo = new InMemoryRepo();
  initRepo(repo);
  return { repo, background: [] };
};

const testTelemetryModelIdentity = {
  model: 'claude-test',
  upstream: 'copilot:1',
  modelKey: 'claude-test-raw', cost: null,
};

const baseInvocation = (
  overrides: {
    sourceApi?: 'messages' | 'responses' | 'chat-completions';
    targetApi?: 'messages' | 'responses' | 'chat-completions';
    model?: string;
    stream?: boolean;
  } = {},
): Invocation<{ model: string; stream?: boolean }> => ({
  sourceApi: overrides.sourceApi ?? 'messages',
  targetApi: overrides.targetApi ?? overrides.sourceApi ?? 'messages',
  model: overrides.model ?? 'claude-test',
  upstream: 'copilot:1',
  payload: {
    model: overrides.model ?? 'claude-test',
    stream: overrides.stream ?? true,
  },
  provider: stubProvider(),
  upstreamModel: stubUpstreamModel(),
  enabledFlags: new Set<string>(),
  headers: {},
});

const baseRequest = (
  harness: TelemetryHarness,
  overrides: { downstreamAbortSignal?: AbortSignal; stream?: boolean; apiKeyId?: string | undefined } = {},
): RequestContext => ({
  requestStartedAt: 0,
  apiKeyId: 'apiKeyId' in overrides ? overrides.apiKeyId : 'key_a',
  clientStream: overrides.stream ?? true,
  runtimeLocation: 'SJC',
  scheduleBackground: (promise: Promise<unknown>) => {
    harness.background.push(promise);
  },
  ...(overrides.downstreamAbortSignal !== undefined ? { downstreamAbortSignal: overrides.downstreamAbortSignal } : {}),
});

test('withUpstreamTelemetry records EOF-without-terminal as upstream failure', async () => {
  const harness = setup();

  const events = withUpstreamTelemetry(
    (async function* () {
      yield { type: 'sse' as const, data: '{"type":"message_start"}' };
    })(),
    baseInvocation(),
    baseRequest(harness),
    'messages',
    performance.now(),
    testTelemetryModelIdentity,
  );

  for await (const _event of events) {
    // Drain to EOF without ever seeing a terminal frame.
  }
  await Promise.all(harness.background);

  const rows = await harness.repo.performance.listAll();
  assertEquals(rows.length, 1);
  assertEquals(rows[0].metricScope, 'upstream_success');
  assertEquals(rows[0].requests, 0);
  assertEquals(rows[0].errors, 1);
});

test('withUpstreamTelemetry records upstream-thrown stream errors as upstream failure', async () => {
  const harness = setup();

  const events = withUpstreamTelemetry(
    (async function* () {
      yield { type: 'sse' as const, data: '{"type":"message_start"}' };
      throw new Error('stream failed');
    })(),
    baseInvocation(),
    baseRequest(harness),
    'messages',
    performance.now(),
    testTelemetryModelIdentity,
  );

  let thrown: unknown;
  try {
    for await (const _event of events) {
      // Consume until upstream throws.
    }
  } catch (error) {
    thrown = error;
  }
  await Promise.all(harness.background);

  assertEquals((thrown as Error)?.message, 'stream failed');
  const rows = await harness.repo.performance.listAll();
  assertEquals(rows.length, 1);
  assertEquals(rows[0].errors, 1);
  assertEquals(rows[0].requests, 0);
});

test('withUpstreamTelemetry does not record consumer-cancelled streams', async () => {
  const harness = setup();

  const iterator = withUpstreamTelemetry(
    (async function* () {
      yield { type: 'sse' as const, data: '{"type":"message_start"}' };
      yield { type: 'sse' as const, data: '{"type":"content_block_delta"}' };
    })(),
    baseInvocation(),
    baseRequest(harness),
    'messages',
    performance.now(),
    testTelemetryModelIdentity,
  )[Symbol.asyncIterator]();

  await iterator.next();
  await iterator.return?.(undefined);
  await Promise.all(harness.background);

  assertEquals(await harness.repo.performance.listAll(), []);
});

test('withUpstreamTelemetry does not record downstream-signal-aborted streams', async () => {
  const harness = setup();
  const downstreamAbortController = new AbortController();

  const events = withUpstreamTelemetry(
    (async function* () {
      downstreamAbortController.abort();
      yield* [];
    })(),
    baseInvocation(),
    baseRequest(harness, { downstreamAbortSignal: downstreamAbortController.signal }),
    'messages',
    performance.now(),
    testTelemetryModelIdentity,
  );

  for await (const _event of events) {
    // Drain the aborted stream to EOF.
  }
  await Promise.all(harness.background);

  assertEquals(await harness.repo.performance.listAll(), []);
});

test('withUpstreamTelemetry records Messages SSE error event as upstream failure', async () => {
  const harness = setup();

  const events = withUpstreamTelemetry(
    (async function* () {
      yield { type: 'sse' as const, data: '{"type":"message_start"}' };
      yield {
        type: 'sse' as const,
        event: 'error',
        data: '{"type":"error","error":{"type":"overloaded_error","message":"slow down"}}',
      };
    })(),
    baseInvocation(),
    baseRequest(harness),
    'messages',
    performance.now(),
    testTelemetryModelIdentity,
  );

  for await (const _event of events) {
    // Consume both frames.
  }
  await Promise.all(harness.background);

  const rows = await harness.repo.performance.listAll();
  assertEquals(rows.length, 1);
  assertEquals(rows[0].errors, 1);
  assertEquals(rows[0].requests, 0);
});

test('withUpstreamTelemetry records Responses SSE failure event as upstream failure', async () => {
  const harness = setup();

  const events = withUpstreamTelemetry(
    (async function* () {
      yield { type: 'sse' as const, data: '{"type":"response.created"}' };
      yield {
        type: 'sse' as const,
        data: '{"type":"response.failed","response":{"status":"failed"}}',
      };
    })(),
    baseInvocation({ sourceApi: 'responses', model: 'gpt-failed-stream' }),
    baseRequest(harness),
    'responses',
    performance.now(),
    testTelemetryModelIdentity,
  );

  for await (const _event of events) {
    // Consume both frames.
  }
  await Promise.all(harness.background);

  const rows = await harness.repo.performance.listAll();
  assertEquals(rows.length, 1);
  assertEquals(rows[0].errors, 1);
  assertEquals(rows[0].requests, 0);
});

test('withUpstreamTelemetry treats DONE as terminal only for chat-completions', async () => {
  for (const targetApi of ['messages', 'responses'] as const) {
    const harness = setup();

    const events = withUpstreamTelemetry(
      (async function* () {
        yield { type: 'sse' as const, data: '[DONE]' };
      })(),
      baseInvocation({
        sourceApi: targetApi,
        model: `gpt-${targetApi}-done`,
      }),
      baseRequest(harness),
      targetApi,
      performance.now(),
      testTelemetryModelIdentity,
    );

    for await (const _event of events) {
      // Consume every upstream frame.
    }
    await Promise.all(harness.background);

    // [DONE] is not a terminal for messages/responses, and the stream ended
    // without one, so this records as an EOF-without-terminal failure.
    const rows = await harness.repo.performance.listAll();
    assertEquals(rows.length, 1);
    assertEquals(rows[0].errors, 1);
    assertEquals(rows[0].requests, 0);
  }
});

test('withUpstreamTelemetry snapshots duration when the success frame arrives', async () => {
  const harness = setup();
  const startedAt = performance.now();

  const iterator = withUpstreamTelemetry(
    (async function* () {
      yield { type: 'sse' as const, data: '{"type":"message_stop"}' };
    })(),
    baseInvocation({ model: 'claude-timing' }),
    baseRequest(harness),
    'messages',
    startedAt,
    testTelemetryModelIdentity,
  )[Symbol.asyncIterator]();

  assertEquals((await iterator.next()).done, false);
  await new Promise(resolve => setTimeout(resolve, 80));
  assertEquals((await iterator.next()).done, true);
  await Promise.all(harness.background);

  const rows = await harness.repo.performance.listAll();
  assertEquals(rows.length, 1);
  assertEquals(rows[0].metricScope, 'upstream_success');
  assertEquals(rows[0].requests, 1);
  assertEquals(rows[0].errors, 0);
  assertEquals(rows[0].totalMsSum < 40, true);
});

test('recordUpstreamHttpFailure records a single error for non-2xx responses', async () => {
  const harness = setup();
  recordUpstreamHttpFailure(baseInvocation({ sourceApi: 'messages' }), baseRequest(harness), 'messages', testTelemetryModelIdentity);
  await Promise.all(harness.background);

  const rows = await harness.repo.performance.listAll();
  assertEquals(rows.length, 1);
  assertEquals(rows[0].metricScope, 'upstream_success');
  assertEquals(rows[0].errors, 1);
  assertEquals(rows[0].requests, 0);
});

test('withUpstreamTelemetry skips recording when apiKeyId is absent', async () => {
  const repo = new InMemoryRepo();
  initRepo(repo);
  const background: Promise<unknown>[] = [];

  const events = withUpstreamTelemetry(
    (async function* () {
      yield { type: 'sse' as const, data: '{"type":"message_stop"}' };
    })(),
    {
      sourceApi: 'messages',
      targetApi: 'messages',
      model: 'claude-anon',
      upstream: 'test-upstream',
      payload: { model: 'claude-anon', stream: true },
      provider: stubProvider(),
      upstreamModel: stubUpstreamModel(),
      enabledFlags: new Set<string>(),
      headers: {},
    },
    {
      requestStartedAt: 0,
      clientStream: true,
      runtimeLocation: 'SJC',
      scheduleBackground: promise => background.push(promise),
    },
    'messages',
    performance.now(),
    testTelemetryModelIdentity,
  );

  for await (const _event of events) {
    // Consume terminal.
  }
  await Promise.all(background);

  assertEquals(await repo.performance.listAll(), []);
});
