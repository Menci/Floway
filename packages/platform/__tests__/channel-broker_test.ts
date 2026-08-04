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
  assertEquals((await iter.return?.())?.done, true);
  assertEquals(stream.locked, false);
});
