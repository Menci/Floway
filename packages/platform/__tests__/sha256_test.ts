import { afterEach, expect, test, vi } from 'vitest';

import { sha256Hex } from '../src/sha256.ts';

const ABC_SHA256 = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';

afterEach(() => {
  vi.restoreAllMocks();
});

test.each([
  ['empty input', new Uint8Array(), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'],
  ['known text', new TextEncoder().encode('abc'), ABC_SHA256],
])('sha256Hex hashes %s', async (_label, input, expected) => {
  expect(await sha256Hex(input)).toBe(expected);
});

test('sha256Hex reuses the backing ArrayBuffer while hashing only the requested view', async () => {
  const bytes = new Uint8Array([0xff, 0x61, 0x62, 0x63, 0xff]);
  const input = bytes.subarray(1, 4);
  const digest = vi.spyOn(crypto.subtle, 'digest');

  expect(await sha256Hex(input)).toBe(ABC_SHA256);

  const digestInput = digest.mock.calls[0]![1] as Uint8Array<ArrayBuffer>;
  expect(digestInput.buffer).toBe(bytes.buffer);
  expect(digestInput.byteOffset).toBe(input.byteOffset);
  expect(digestInput.byteLength).toBe(input.byteLength);
});

test.runIf(typeof SharedArrayBuffer !== 'undefined')('sha256Hex copies a SharedArrayBuffer view before hashing it', async () => {
  const shared = new SharedArrayBuffer(5);
  const bytes = new Uint8Array(shared);
  bytes.set([0xff, 0x61, 0x62, 0x63, 0xff]);
  const digest = vi.spyOn(crypto.subtle, 'digest');

  expect(await sha256Hex(bytes.subarray(1, 4))).toBe(ABC_SHA256);

  const digestInput = digest.mock.calls[0]![1] as Uint8Array<ArrayBuffer>;
  expect(digestInput.buffer).toBeInstanceOf(ArrayBuffer);
  expect(digestInput.buffer).not.toBe(shared);
  expect([...digestInput]).toEqual([0x61, 0x62, 0x63]);
});
