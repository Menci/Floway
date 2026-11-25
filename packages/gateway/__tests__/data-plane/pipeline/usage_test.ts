import { expect, test, vi } from 'vitest';

import { computeUsage } from '../../../src/data-plane/pipeline/compute-usage.ts';
import { gatewayFactSpace, type ServeCandidate } from '../../../src/data-plane/pipeline/facts.ts';
import { recordPerformance, type PerformanceServices } from '../../../src/data-plane/pipeline/performance.ts';
import { responseHead } from '../../../src/data-plane/pipeline/response.ts';
import { storeUsage, type UsageStoreServices } from '../../../src/data-plane/pipeline/store-usage.ts';
import { tokenUsageMeasurement } from '../../../src/data-plane/shared/telemetry/usage.ts';
import type { UsageRecord } from '../../../src/repo/types.ts';
import { move, run, type Result, type RunEvent } from '@floway-dev/pipeline';
import type { OpenAICompletionsStreamEvent } from '@floway-dev/protocols/openai-completions';
import type { ProtocolStreamError } from '@floway-dev/provider';

const { compose, defineStage } = gatewayFactSpace<UsageStoreServices & PerformanceServices>();
const responseKey = 'response.openaiCompletions';
const failure = new Error('upstream stopped');
const candidate: ServeCandidate = {
  upstream: { id: 'upstream', kind: 'custom', name: 'Provider', config: {} },
  model: {
    id: 'public', upstreamModelId: 'wire', kind: 'chat', limits: {},
    endpoints: { openaiCompletions: {} }, opaqueBlobCompatibilityScope: { bindToUpstream: false }, enabledFlags: [],
  },
};

const executeStream = (terminal: 'transport' | 'cancel' | 'panic', reported: boolean) => {
  const controller = new AbortController();
  const events: RunEvent[] = [];
  const ending = defineStage({
    name: 'test.usage-stream',
    request: { needs: [] },
    return: { provides: ['response.http', 'response.modelKey', responseKey] },
    async execute(_facts, scope) {
      const stream = scope.createStream(async function* ({ signal }): AsyncIterable<Result<OpenAICompletionsStreamEvent, ProtocolStreamError>> {
        yield {
          ok: true,
          value: {
            id: 'completion', object: 'text_completion', created: 1, model: 'wire', choices: [],
            ...(reported && { usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } }),
          },
        };
        if (terminal === 'panic') throw failure;
        if (terminal === 'cancel') {
          expect(signal.aborted).toBe(true);
          yield { ok: false, error: { kind: 'abort', cause: signal.reason } };
        } else {
          yield { ok: false, error: { kind: 'transport', cause: failure } };
        }
      });
      return {
        'response.http': move(responseHead(200)),
        'response.modelKey': 'wire',
        [responseKey]: move({ kind: 'stream', stream }),
      };
    },
  });
  const pipeline = compose('test.meter-stream', {
    entry: ['request.auth.apiKeyId', 'serve.candidate'],
    exit: ['response.http', responseKey],
    stages: [
      storeUsage,
      recordPerformance(responseKey, 'text_completion'),
      computeUsage(responseKey, {
        kind: 'billable',
        stream: () => ({
          observe: event => event.usage === undefined ? null : tokenUsageMeasurement({ input: event.usage.prompt_tokens, output: event.usage.completion_tokens }),
          finish: () => null,
        }),
      }),
    ],
    ending,
  });
  const store = vi.fn(async (_row: UsageRecord) => {});
  const recordNeutral = vi.fn(async () => {});
  const recordZeroOutputError = vi.fn(async () => {});
  const recordSample = vi.fn(async () => {});
  const handle = run(pipeline, { 'request.auth.apiKeyId': 'key-id', 'serve.candidate': move(candidate) }, {
    signal: controller.signal,
    events: event => { events.push(event); },
    services: { runtimeLocation: 'TEST', storeUsage: store, performance: { recordNeutral, recordZeroOutputError, recordSample } },
  });
  return { handle, controller, events, store, recordNeutral, recordZeroOutputError, recordSample };
};

test.each(['transport', 'panic'] as const)('a %s failure preserves usage written before native completion', async terminal => {
  const { handle, controller, store, recordNeutral, recordZeroOutputError, recordSample } = executeStream(terminal, true);
  const outcome = (await handle.result)[responseKey];
  if (outcome.kind !== 'stream') throw new Error('Expected a stream outcome');
  const cursor = outcome.stream[Symbol.asyncIterator]();
  expect(await cursor.next()).toMatchObject({ done: false, value: { ok: true } });
  await vi.waitFor(() => expect(store).toHaveBeenCalledOnce());
  expect(store).toHaveBeenCalledWith(expect.objectContaining({
    keyId: 'key-id', model: 'public', modelKey: 'wire', upstream: 'upstream', requests: 1,
    metrics: [{ metric: 'input_tokens', quantity: '3', unitPrice: null }, { metric: 'output_tokens', quantity: '2', unitPrice: null }],
  }));
  expect(recordZeroOutputError).not.toHaveBeenCalled();

  if (terminal === 'panic') {
    await expect(cursor.next()).rejects.toBe(failure);
    controller.abort(failure);
    await expect(handle.done).rejects.toBe(failure);
    expect(recordZeroOutputError).not.toHaveBeenCalled();
  } else {
    expect(await cursor.next()).toMatchObject({ done: false, value: { ok: false, error: { kind: 'transport' } } });
    controller.abort(failure);
    expect((await cursor.next()).done).toBe(true);
    await handle.done;
    expect(recordZeroOutputError).toHaveBeenCalledOnce();
  }
  expect(store).toHaveBeenCalledOnce();
  expect(recordSample).not.toHaveBeenCalled();
  expect(recordNeutral).not.toHaveBeenCalled();
});

test('cancellation before usage produces neither usage nor a performance row', async () => {
  const { handle, controller, events, store, recordNeutral, recordZeroOutputError, recordSample } = executeStream('cancel', false);
  const outcome = (await handle.result)[responseKey];
  if (outcome.kind !== 'stream') throw new Error('Expected a stream outcome');
  const cursor = outcome.stream[Symbol.asyncIterator]();
  expect(await cursor.next()).toMatchObject({ done: false, value: { ok: true } });
  controller.abort();
  expect(await cursor.next()).toMatchObject({ done: false, value: { ok: false, error: { kind: 'abort' } } });
  expect((await cursor.next()).done).toBe(true);
  await handle.done;

  expect(events).toContainEqual(expect.objectContaining({
    type: 'deferred.settled', ok: true, value: { observation: { kind: 'cancelled-before-usage' }, row: null },
  }));
  expect(store).not.toHaveBeenCalled();
  expect(recordNeutral).not.toHaveBeenCalled();
  expect(recordZeroOutputError).not.toHaveBeenCalled();
  expect(recordSample).not.toHaveBeenCalled();
});
