import { expect, test, vi } from 'vitest';

import { createResponsesResponseId } from '../../../../src/data-plane/chat/responses/response-id.ts';

test('creates a 128-bit lowercase-hex response envelope id', () => {
  const random = vi.spyOn(crypto, 'getRandomValues').mockImplementation(<T extends ArrayBufferView | null>(array: T): T => {
    if (!(array instanceof Uint8Array)) throw new TypeError('expected a Uint8Array');
    array.set(Uint8Array.from({ length: array.length }, (_, index) => index));
    return array;
  });

  try {
    expect(createResponsesResponseId()).toBe('resp_000102030405060708090a0b0c0d0e0f');
    expect(random).toHaveBeenCalledOnce();
    expect(random.mock.calls[0]?.[0]).toHaveLength(16);
  } finally {
    random.mockRestore();
  }
});
