import { expect, test } from 'vitest';

import { readHttpResponseBody } from '../src/fact-body.ts';

test.each(['abort', 'transport'] as const)('response body classifies an errored stream during abort as %s', async kind => {
  const controller = new AbortController();
  const reason = new DOMException('Interrupted response', 'AbortError');
  const cause = kind === 'abort' ? reason : new Error('Socket closed before cancel');
  const reading = Promise.withResolvers<void>();
  const body = new ReadableStream<Uint8Array>({
    start(output) {
      controller.signal.addEventListener('abort', () => { output.error(cause); }, { once: true });
    },
    pull() { reading.resolve(); },
  }, { highWaterMark: 0 });

  const iterator = readHttpResponseBody(body, controller.signal);
  const pending = iterator.next();
  await reading.promise;
  controller.abort(reason);

  const first = await pending;
  expect(first).toMatchObject({ done: false, value: { ok: false, error: { kind } } });
  if (first.done || first.value.ok) throw new TypeError('Expected the body failure');
  expect(first.value.error.cause).toBe(cause);
  expect((await iterator.next()).done).toBe(true);
});
