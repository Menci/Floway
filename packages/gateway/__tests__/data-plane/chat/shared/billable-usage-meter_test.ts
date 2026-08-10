import { expect, test } from 'vitest';

import { meteringBillableUsage } from '../../../../src/data-plane/chat/shared/billable-usage-meter.ts';
import type { BillableUsage, ProtocolFrame } from '@floway-dev/protocols/common';
import { eventResult, type ChatTargetApi, type EventResultMetadata, type ExecuteResult } from '@floway-dev/provider';
import { testTelemetryModelIdentity } from '@floway-dev/test-utils';

interface UsageEvent {
  readonly type: string;
  readonly usage?: BillableUsage;
}

const usage = (input: number, output: number): BillableUsage => ({ input, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, output });

const meter = meteringBillableUsage<{ targetApi: ChatTargetApi }, unknown, UsageEvent>(
  'responses',
  () => event => event.usage ?? null,
);

const meterOver = async (
  events: AsyncIterable<ProtocolFrame<UsageEvent>>,
  options: { targetApi?: ChatTargetApi; finalMetadata?: Promise<EventResultMetadata> } = {},
): Promise<Extract<ExecuteResult<ProtocolFrame<UsageEvent>>, { type: 'events' }>> => {
  const result = await meter({ targetApi: options.targetApi ?? 'responses' }, {}, () =>
    Promise.resolve(eventResult(events, testTelemetryModelIdentity, {
      ...(options.finalMetadata ? { finalMetadata: options.finalMetadata } : {}),
    })));
  if (result.type !== 'events') throw new Error(`expected events result, got ${result.type}`);
  return result;
};

const framesOf = (...events: readonly UsageEvent[]): AsyncIterable<ProtocolFrame<UsageEvent>> => (async function* () {
  for (const event of events) yield { type: 'event', event } as const;
})();

test('bills the last report carrying real counts', async () => {
  const result = await meterOver(framesOf(
    { type: 'response.created' },
    { type: 'response.in_progress', usage: usage(7, 1) },
    { type: 'response.completed', usage: usage(7, 3) },
  ));
  for await (const _ of result.events) { /* drain */ }
  expect((await result.finalMetadata!).billableUsage).toEqual(usage(7, 3));
});

test('stands down when the chain translated into another protocol', async () => {
  const result = await meterOver(framesOf({ type: 'response.completed', usage: usage(7, 3) }), { targetApi: 'chat-completions' });
  for await (const _ of result.events) { /* drain */ }
  expect(result.finalMetadata).toBe(undefined);
});

// A native compaction states its counts in the body rather than in a stream,
// and a probe answered without dialing states that it has none. Neither is a
// figure the meter may overwrite from synthesized frames.
test('leaves an inner figure alone when the stream reports none', async () => {
  const inner: EventResultMetadata = { modelIdentity: testTelemetryModelIdentity, billableUsage: usage(11, 5) };
  const result = await meterOver(framesOf({ type: 'response.completed' }), { finalMetadata: Promise.resolve(inner) });
  for await (const _ of result.events) { /* drain */ }
  expect((await result.finalMetadata!).billableUsage).toEqual(usage(11, 5));
});

test('settles on cancellation, because a cancelled turn is billed like any other', async () => {
  const result = await meterOver(framesOf(
    { type: 'response.in_progress', usage: usage(7, 1) },
    { type: 'response.completed', usage: usage(7, 3) },
  ));
  const iterator = result.events[Symbol.asyncIterator]();
  await iterator.next();
  await iterator.return!();
  expect((await result.finalMetadata!).billableUsage).toEqual(usage(7, 1));
});

test('does not settle before the terminal usage frame is drained', async () => {
  let releaseTerminal!: (frame: ProtocolFrame<UsageEvent>) => void;
  const terminal = new Promise<ProtocolFrame<UsageEvent>>(resolve => { releaseTerminal = resolve; });
  const result = await meterOver((async function* () {
    yield { type: 'event', event: { type: 'response.created' } } as const;
    yield await terminal;
  })());

  const iterator = result.events[Symbol.asyncIterator]();
  await iterator.next();
  let settled = false;
  void result.finalMetadata!.then(() => { settled = true; });
  await Promise.resolve();
  expect(settled).toBe(false);

  releaseTerminal({ type: 'event', event: { type: 'response.completed', usage: usage(7, 3) } });
  await iterator.next();
  await iterator.next();
  expect((await result.finalMetadata!).billableUsage).toEqual(usage(7, 3));
});
