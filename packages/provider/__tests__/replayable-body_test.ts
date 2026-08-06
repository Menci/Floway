import { expect, test } from 'vitest';

import { createReplayableBody, nativeFetchInit, replayableBodySource, replayableBodyStream } from '../src/replayable-body.ts';

const read = async (body: BodyInit): Promise<number[]> =>
  Array.from(new Uint8Array(await new Response(body).arrayBuffer()));

test('replayable body streams immutable segment views without concatenating them', async () => {
  const first = Uint8Array.of(1, 2);
  const second = Uint8Array.of(3, 4);
  const stream = createReplayableBody([first, second]);
  const source = replayableBodySource(stream);

  expect(source).not.toBeNull();
  expect(source?.segments).toEqual([first, second]);
  expect(source?.byteLength).toBe(4);
  expect(await read(stream)).toEqual([1, 2, 3, 4]);
  expect(await read(replayableBodyStream(source!))).toEqual([1, 2, 3, 4]);
});

test('native fetch init creates a fresh stream and authoritative content length', async () => {
  const original = createReplayableBody([Uint8Array.of(1), Uint8Array.of(2, 3)]);
  const init = nativeFetchInit({ method: 'POST', headers: { 'content-length': '999' }, body: original });

  expect(init.body).toBeInstanceOf(ReadableStream);
  expect(init.body).not.toBe(original);
  expect(new Headers(init.headers).get('content-length')).toBe('3');
  expect(await read(init.body!)).toEqual([1, 2, 3]);
});
