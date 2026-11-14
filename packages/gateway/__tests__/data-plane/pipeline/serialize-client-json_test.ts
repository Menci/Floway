import { expect, test } from 'vitest';

import type { GatewayFacts } from '../../../src/data-plane/pipeline/facts.ts';
import { serializeClientJson } from '../../../src/data-plane/pipeline/serialize-client-json.ts';
import { writeSettlement } from '../../../src/data-plane/pipeline/settlement.ts';
import { initRepo } from '../../../src/repo/index.ts';
import { InMemoryRepo } from '../../repo/memory.ts';
import { mockGatewayCtx } from '../../test-utils/gateway-ctx.ts';
import { compose, defineStage, getFailureFacts, move, run, type Event } from '@floway-dev/pipeline';
import { mockPerfTelemetryContext } from '@floway-dev/test-utils';

const renderedKey = 'response.test.rendered';
const answer = (value: unknown) => defineStage<Record<string, never>, Record<typeof renderedKey, unknown> & Pick<GatewayFacts, 'response.usage.billable' | 'response.http.status'>>({
  name: 'answer',
  return: { provides: [renderedKey, 'response.usage.billable', 'response.http.status'] },
  execute: async facts => move({
    ...facts, [renderedKey]: value, 'response.http.status': 200,
    'response.usage.billable': [{
      identity: { model: 'm', upstream: 'u', modelKey: 'm', pricing: null },
      quantities: { input_tokens: '3', output_tokens: '2' },
    }],
  }),
});

test('serializes client JSON within the run while preserving the canonical object', async () => {
  const value = move({ text: '中' });
  const pipeline = compose<Record<string, never>, Record<string, unknown>>('json', [serializeClientJson(renderedKey), answer(value)]);
  const executed = await run(pipeline, move({}), {});
  expect(executed.facts[renderedKey]).toBe(value);
  expect(new TextDecoder().decode(executed.facts['response.http.jsonBody'] as Uint8Array)).toBe('{"text":"中"}');
  await executed.drain();
});

test('rejects a client value without a JSON representation', async () => {
  await expect(run(compose('invalidJson', [serializeClientJson(renderedKey), answer(undefined)]), move({}), {}))
    .rejects.toThrow('Client JSON body has no JSON representation');
});

test('leaves streams and upstream documents to their owning transport', async () => {
  for (const value of [new Uint8Array([0, 255, 1]), { async *[Symbol.asyncIterator]() { yield 'frame'; } }]) {
    const pipeline = compose<Record<string, never>, Record<string, unknown>>('nonJson', [serializeClientJson(renderedKey), answer(value)]);
    const executed = await run(pipeline, move({}), {});
    expect(executed.facts[renderedKey]).toBe(value);
    expect(executed.facts['response.http.jsonBody']).toBeNull();
    await executed.drain();
  }
});

test('a JSON encoding fault settles measured usage as a failure and retains the failure facts', async () => {
  const repo = new InMemoryRepo(); initRepo(repo);
  const value = move({ extension: 1n });
  const work: Promise<unknown>[] = [];
  const events: Event[] = [];
  const gateway = mockGatewayCtx({
    attempt: {
      timing: { upstreamCallStartedAt: 50, firstOutputTokenAt: 100 },
      telemetry: mockPerfTelemetryContext(),
    },
  });
  const pipeline = compose('encodingFailure', [
    writeSettlement(() => false), serializeClientJson(renderedKey), answer(value),
  ]);
  const error = await run(pipeline, move({}), {
    gateway, background: (promise: Promise<unknown>) => { work.push(promise); },
    dump: (event: Event) => { events.push(event); },
  }).then(() => { throw new Error('Expected JSON serialization to reject'); }, error => error as unknown);
  expect(error).toBeInstanceOf(TypeError);
  expect(getFailureFacts(error)?.[renderedKey]).toBe(value);
  expect(events.find((event): event is Extract<Event, { type: 'stage.failed' }> => event.type === 'stage.failed' && event.stageId === 2)?.error).toBe(error);
  await Promise.all(work);
  expect(await repo.usage.listAll()).toMatchObject([{ requests: 1, metrics: expect.arrayContaining([{ metric: 'input_tokens', quantity: '3', unitPrice: null }, { metric: 'output_tokens', quantity: '2', unitPrice: null }]) }]);
  expect(await repo.performance.listAll()).toMatchObject([{ errorsWithOutput: 1, errorsNoOutput: 0 }]);
});
