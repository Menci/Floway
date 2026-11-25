import { expect, test } from 'vitest';

import { readHttpResponseBody, readHttpResponseText } from '../src/fact-body.ts';

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

test('reads text through native done even when a UTF-8 character crosses chunks', async () => {
  const bytes = new TextEncoder().encode('例');
  const body = new ReadableStream<Uint8Array>({
    start(output) {
      output.enqueue(bytes.subarray(0, 1));
      output.enqueue(bytes.subarray(1));
      output.close();
    },
  });
  await expect(readHttpResponseText(new Response(body))).resolves.toEqual({ ok: true, value: '例' });
  expect(body.locked).toBe(false);
});

test('returns a body transport failure with its original cause and releases the reader', async () => {
  const cause = new Error('Socket closed');
  const body = new ReadableStream<Uint8Array>({ pull(output) { output.error(cause); } });
  const result = await readHttpResponseText(new Response(body));
  expect(result).toEqual({ ok: false, error: { kind: 'transport', cause } });
  expect(body.locked).toBe(false);
});

test('returns an abort failure after cancellation and native done', async () => {
  const controller = new AbortController();
  const reason = new Error('stop');
  const reading = Promise.withResolvers<void>();
  const cancelled = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<void>();
  const body = new ReadableStream<Uint8Array>({
    pull() { reading.resolve(); },
    cancel(cause) {
      expect(cause).toBe(reason);
      cancelled.resolve();
      return finish.promise;
    },
  }, { highWaterMark: 0 });
  const result = readHttpResponseText(new Response(body), controller.signal);
  await reading.promise;
  controller.abort(reason);
  await cancelled.promise;
  expect(body.locked).toBe(true);
  finish.resolve();
  await expect(result).resolves.toEqual({ ok: false, error: { kind: 'abort', cause: reason } });
  expect(body.locked).toBe(false);
});
