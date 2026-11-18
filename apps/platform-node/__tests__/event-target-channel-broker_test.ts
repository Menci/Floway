import { test } from 'vitest';

import { EventTargetChannelBroker } from '../src/event-target-channel-broker.ts';
import type { ChannelCodec } from '@floway-dev/platform';
import { assertEquals } from '@floway-dev/test-utils';

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

test('EventTargetChannelBroker buffers published payloads before the first read', async () => {
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

test('EventTargetChannelBroker drains buffered payloads before surfacing a decode failure', async () => {
  const broker = new EventTargetChannelBroker<string>(rejectingStringCodec);
  const controller = new AbortController();
  const iter = broker.subscribe('k', controller.signal)[Symbol.asyncIterator]();

  await broker.publish('k', 'good');
  await broker.publish('k', 'bad');

  assertEquals((await iter.next()).value, 'good');
  const failed = await Promise.allSettled([iter.next()]);
  assertEquals(failed[0].status, 'rejected');
  assertEquals((failed[0] as PromiseRejectedResult).reason.message, 'rejected payload: bad');
});
