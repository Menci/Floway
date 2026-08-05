import { test } from 'vitest';

import { EventTargetChannelBroker } from '../src/event-target-channel-broker.ts';
import { CHANNEL_SUBSCRIPTION_BUFFER_CAPACITY, type ChannelCodec } from '@floway-dev/platform';
import { assertEquals, assertRejects } from '@floway-dev/test-utils';

// String codec: encode passes through, decode is identity. Every test below
// drives the generic broker through this codec, so the broker's typing flows
// without any reference to a higher-level payload shape.
const stringCodec: ChannelCodec<string> = {
  encode: value => value,
  decode: payload => payload,
};

const rejectingStringCodec: ChannelCodec<string> = {
  encode: value => value,
  decode: payload => {
    if (payload === 'bad') throw new Error(`rejected payload: ${payload}`);
    return payload;
  },
};

const activeChannelCount = <T>(broker: EventTargetChannelBroker<T>): number => {
  const targets: unknown = Object.getOwnPropertyDescriptor(broker, 'targets')?.value;
  if (!(targets instanceof Map)) throw new Error('EventTargetChannelBroker targets map is unavailable');
  return targets.size;
};

test('EventTargetChannelBroker retains state only while a channel has subscribers', async () => {
  const broker = new EventTargetChannelBroker<string>(stringCodec);
  await broker.publish('without-subscribers', 'discarded');
  assertEquals(activeChannelCount(broker), 0);

  const first = (await broker.subscribe('k', new AbortController().signal))[Symbol.asyncIterator]();
  const second = (await broker.subscribe('k', new AbortController().signal))[Symbol.asyncIterator]();
  assertEquals(activeChannelCount(broker), 1);

  await first.return?.();
  assertEquals(activeChannelCount(broker), 1);
  await second.return?.();
  assertEquals(activeChannelCount(broker), 0);
});

test('EventTargetChannelBroker supports intentional fan-out without listener warnings', async () => {
  const broker = new EventTargetChannelBroker<string>(stringCodec);
  const controllers = Array.from({ length: 11 }, () => new AbortController());
  const warnings: Error[] = [];
  const onWarning = (warning: Error): void => {
    if (warning.name === 'MaxListenersExceededWarning') warnings.push(warning);
  };
  process.on('warning', onWarning);
  try {
    await Promise.all(controllers.map(controller => broker.subscribe('k', controller.signal)));
    await new Promise<void>(resolve => setImmediate(resolve));
    assertEquals(warnings, []);
  } finally {
    for (const controller of controllers) controller.abort();
    process.off('warning', onWarning);
  }
});

test('EventTargetChannelBroker terminates a slow subscriber at the bounded queue capacity', async () => {
  const broker = new EventTargetChannelBroker<string>(stringCodec);
  const iter = (await broker.subscribe('k', new AbortController().signal))[Symbol.asyncIterator]();

  for (let i = 0; i <= CHANNEL_SUBSCRIPTION_BUFFER_CAPACITY; i += 1) {
    await broker.publish('k', `frame-${i}`);
  }

  assertEquals(activeChannelCount(broker), 0);
  for (let i = 0; i < CHANNEL_SUBSCRIPTION_BUFFER_CAPACITY; i += 1) {
    assertEquals((await iter.next()).value, `frame-${i}`);
  }
  await assertRejects(
    () => iter.next(),
    Error,
    `Channel subscriber exceeded ${CHANNEL_SUBSCRIPTION_BUFFER_CAPACITY} buffered frames`,
  );
});

test('EventTargetChannelBroker discards buffered payloads when the subscriber aborts', async () => {
  const broker = new EventTargetChannelBroker<string>(stringCodec);
  const controller = new AbortController();
  const iter = (await broker.subscribe('k', controller.signal))[Symbol.asyncIterator]();

  await broker.publish('k', 'a1');
  await broker.publish('k', 'a2');
  controller.abort();

  assertEquals((await iter.next()).done, true);
});

test('EventTargetChannelBroker does not attach listeners for an already-aborted subscription', async () => {
  const originalAdd = EventTarget.prototype.addEventListener;
  let adds = 0;
  EventTarget.prototype.addEventListener = function (...args: Parameters<EventTarget['addEventListener']>) {
    adds += 1;
    return originalAdd.apply(this, args);
  };
  try {
    const broker = new EventTargetChannelBroker<string>(stringCodec);
    const controller = new AbortController();
    controller.abort();

    const iter = (await broker.subscribe('k', controller.signal))[Symbol.asyncIterator]();

    assertEquals((await iter.next()).done, true);
    assertEquals(adds, 0);
  } finally {
    EventTarget.prototype.addEventListener = originalAdd;
  }
});

test('EventTargetChannelBroker resolves concurrent reads in publish order', async () => {
  const broker = new EventTargetChannelBroker<string>(stringCodec);
  const controller = new AbortController();
  const iter = (await broker.subscribe('k', controller.signal))[Symbol.asyncIterator]();
  const first = iter.next();
  const second = iter.next();

  await broker.publish('k', 'a1');
  await broker.publish('k', 'a2');

  assertEquals((await first).value, 'a1');
  assertEquals((await second).value, 'a2');
  controller.abort();
});

test('EventTargetChannelBroker rejects every pending read when decoding fails', async () => {
  const broker = new EventTargetChannelBroker<string>(rejectingStringCodec);
  const controller = new AbortController();
  const iter = (await broker.subscribe('k', controller.signal))[Symbol.asyncIterator]();
  const first = iter.next();
  const second = iter.next();

  await broker.publish('k', 'bad');

  const results = await Promise.allSettled([first, second]);
  assertEquals(results.map(result => result.status), ['rejected', 'rejected']);
  assertEquals((results[0] as PromiseRejectedResult).reason.message, 'rejected payload: bad');
  assertEquals((results[1] as PromiseRejectedResult).reason.message, 'rejected payload: bad');
});

test('EventTargetChannelBroker drains buffered payloads before surfacing a decode failure', async () => {
  const broker = new EventTargetChannelBroker<string>(rejectingStringCodec);
  const controller = new AbortController();
  const iter = (await broker.subscribe('k', controller.signal))[Symbol.asyncIterator]();

  await broker.publish('k', 'good');
  await broker.publish('k', 'bad');

  assertEquals((await iter.next()).value, 'good');
  const failed = await Promise.allSettled([iter.next()]);
  assertEquals(failed[0].status, 'rejected');
  assertEquals((failed[0] as PromiseRejectedResult).reason.message, 'rejected payload: bad');
});

test('EventTargetChannelBroker isolates traffic across channels', async () => {
  const broker = new EventTargetChannelBroker<string>(stringCodec);
  const controller = new AbortController();
  const iter = (await broker.subscribe('k1', controller.signal))[Symbol.asyncIterator]();
  await broker.publish('k2', 'foreign');
  await broker.publish('k1', 'local');

  const first = await iter.next();
  assertEquals(first.value, 'local');
  controller.abort();
  assertEquals((await iter.next()).done, true);
});

test('EventTargetChannelBroker.closeChannel ends every subscriber on the channel', async () => {
  const broker = new EventTargetChannelBroker<string>(stringCodec);
  const c1 = new AbortController();
  const c2 = new AbortController();
  const i1 = (await broker.subscribe('k', c1.signal))[Symbol.asyncIterator]();
  const i2 = (await broker.subscribe('k', c2.signal))[Symbol.asyncIterator]();

  await broker.closeChannel('k', 'shut down');
  assertEquals((await i1.next()).done, true);
  assertEquals((await i2.next()).done, true);
});

test('EventTargetChannelBroker detaches its EventTarget listeners when the subscriber aborts before pulling', async () => {
  // Spy on `removeEventListener` so we can count detach calls. The abort path
  // must detach the listeners synchronously rather than waiting for a future
  // iterator pull.
  const originalRemove = EventTarget.prototype.removeEventListener;
  let removes = 0;
  EventTarget.prototype.removeEventListener = function (...args: Parameters<EventTarget['removeEventListener']>) {
    removes += 1;
    return originalRemove.apply(this, args);
  };
  try {
    const broker = new EventTargetChannelBroker<string>(stringCodec);
    const controller = new AbortController();
    await broker.subscribe('k', controller.signal);
    // Snapshot the removal counter immediately before the abort so the test
    // scopes the assertion to the listeners this subscribe actually owns.
    const removesBefore = removes;
    controller.abort();
    // Two listeners on the EventTarget (frame + close) plus the abort
    // listener on the signal must be removed.
    assertEquals(removes - removesBefore, 3);
  } finally {
    EventTarget.prototype.removeEventListener = originalRemove;
  }
});

test('EventTargetChannelBroker detaches its EventTarget listeners when the iterator returns', async () => {
  const originalRemove = EventTarget.prototype.removeEventListener;
  let removes = 0;
  EventTarget.prototype.removeEventListener = function (...args: Parameters<EventTarget['removeEventListener']>) {
    removes += 1;
    return originalRemove.apply(this, args);
  };
  try {
    const broker = new EventTargetChannelBroker<string>(stringCodec);
    const controller = new AbortController();
    const iter = (await broker.subscribe('k', controller.signal))[Symbol.asyncIterator]();
    const removesBefore = removes;

    await iter.return?.();

    assertEquals(removes - removesBefore, 3);
  } finally {
    EventTarget.prototype.removeEventListener = originalRemove;
  }
});
