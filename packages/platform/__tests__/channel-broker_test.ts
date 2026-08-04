import { test } from 'vitest';

import { iterateReadableStream } from '../src/channel-broker.ts';
import { assertEquals } from '@floway-dev/test-utils';

test('iterateReadableStream releases its reader after every pending read observes an error', async () => {
  let controller!: ReadableStreamDefaultController<string>;
  const stream = new ReadableStream<string>({
    start: value => { controller = value; },
  });
  const iter = iterateReadableStream(stream)[Symbol.asyncIterator]();
  const first = iter.next();
  const second = iter.next();
  const error = new Error('terminal');

  controller.error(error);

  const results = await Promise.allSettled([first, second]);
  assertEquals(results.map(result => result.status), ['rejected', 'rejected']);
  assertEquals((results[0] as PromiseRejectedResult).reason, error);
  assertEquals((results[1] as PromiseRejectedResult).reason, error);
  assertEquals(stream.locked, false);
  assertEquals(await iter.return?.('terminal'), { done: true, value: 'terminal' });
  assertEquals(stream.locked, false);
});

test('iterateReadableStream releases its reader before pending cancellation finishes', async () => {
  let cancelReason: unknown;
  let resolveCancellation!: () => void;
  const cancellation = new Promise<void>(resolve => { resolveCancellation = resolve; });
  const stream = new ReadableStream<string>({
    cancel: reason => {
      cancelReason = reason;
      return cancellation;
    },
  });
  const iter = iterateReadableStream(stream)[Symbol.asyncIterator]();
  const pendingRead = iter.next();

  const returned = iter.return?.('subscriber done')!;
  let returnSettled = false;
  void returned.then(() => { returnSettled = true; });
  assertEquals((await pendingRead).done, true);
  await Promise.resolve();

  assertEquals(cancelReason, 'subscriber done');
  assertEquals(stream.locked, false);
  assertEquals(returnSettled, false);

  resolveCancellation();
  assertEquals(await returned, { done: true, value: 'subscriber done' });
  assertEquals(await iter.return?.('already done'), { done: true, value: 'already done' });
});

test('iterateReadableStream propagates one cancellation rejection to concurrent returns', async () => {
  let cancelReason: unknown;
  let rejectCancellation!: (error: unknown) => void;
  const error = new Error('cancel failed');
  const stream = new ReadableStream<string>({
    cancel: reason => {
      cancelReason = reason;
      return new Promise<void>((_resolve, reject) => { rejectCancellation = reject; });
    },
  });
  const iter = iterateReadableStream(stream)[Symbol.asyncIterator]();

  const first = iter.return?.('first')!;
  const second = iter.return?.('second')!;

  assertEquals(cancelReason, 'first');
  assertEquals(stream.locked, false);
  rejectCancellation(error);

  const results = await Promise.allSettled([first, second]);
  assertEquals(results.map(result => result.status), ['rejected', 'rejected']);
  assertEquals((results[0] as PromiseRejectedResult).reason, error);
  assertEquals((results[1] as PromiseRejectedResult).reason, error);
});
