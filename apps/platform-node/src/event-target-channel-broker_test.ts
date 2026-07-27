import { test } from 'vitest';

import { EventTargetChannelBroker } from './event-target-channel-broker.ts';
import type { ChannelCodec } from '@floway-dev/platform';
import { assertEquals } from '@floway-dev/test-utils';

// String codec: encode passes through, decode is identity. Every test below
// drives the generic broker through this codec, so the broker's typing flows
// without any reference to a higher-level payload shape.
const stringCodec: ChannelCodec<string> = {
  encode: value => value,
  decode: payload => payload,
};

test('EventTargetChannelBroker delivers published payloads to a live subscriber', async () => {
  const broker = new EventTargetChannelBroker<string>(stringCodec);
  const controller = new AbortController();
  const iter = broker.subscribe('k', controller.signal)[Symbol.asyncIterator]();

  await broker.publish('k', 'a1');
  await broker.publish('k', 'a2');
  controller.abort();

  // Two seeded items + the abort-induced terminal value.
  assertEquals((await iter.next()).value, 'a1');
  assertEquals((await iter.next()).value, 'a2');
  assertEquals((await iter.next()).done, true);
});

test('EventTargetChannelBroker isolates traffic across channels', async () => {
  const broker = new EventTargetChannelBroker<string>(stringCodec);
  const controller = new AbortController();
  const iter = broker.subscribe('k1', controller.signal)[Symbol.asyncIterator]();
  await broker.publish('k2', 'foreign');
  await broker.publish('k1', 'local');
  controller.abort();

  const first = await iter.next();
  assertEquals(first.value, 'local');
  assertEquals((await iter.next()).done, true);
});

test('EventTargetChannelBroker.closeChannel ends every subscriber on the channel', async () => {
  const broker = new EventTargetChannelBroker<string>(stringCodec);
  const c1 = new AbortController();
  const c2 = new AbortController();
  const i1 = broker.subscribe('k', c1.signal)[Symbol.asyncIterator]();
  const i2 = broker.subscribe('k', c2.signal)[Symbol.asyncIterator]();

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
    broker.subscribe('k', controller.signal);
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
