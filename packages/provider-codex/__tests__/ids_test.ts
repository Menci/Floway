import { parse, validate, version } from 'uuid';
import { afterEach, describe, expect, test, vi } from 'vitest';

import { sha256JsonUuid, uuidV7 } from '../src/ids.ts';

afterEach(() => {
  vi.restoreAllMocks();
});

test('sha256JsonUuid preserves the legacy concatenated JSON digest', async () => {
  const value = [{ type: 'message', role: 'user', content: [{ type: 'input_image', image_url: 'data:image/png;base64,AAAA' }] }];
  const prefix = 'instructions\u0001';
  const id = await sha256JsonUuid(value, prefix);
  const digest = new Uint8Array(await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(`${prefix}${JSON.stringify(value)}`),
  )).slice(0, 16);
  digest[6] = (digest[6]! & 0x0f) | 0x40;
  digest[8] = (digest[8]! & 0x3f) | 0x80;

  expect(id).toBe('1c2f7ec8-b105-4f3d-9be3-e52e795f1423');
  expect([...parse(id)]).toEqual([...digest]);
  expect(validate(id)).toBe(true);
  expect(version(id)).toBe(4);
  expect(parse(id)[8] & 0xc0).toBe(0x80);
});

describe('uuidV7', () => {
  test('emits RFC UUIDv7 identifiers', () => {
    const id = uuidV7();

    expect(validate(id)).toBe(true);
    expect(version(id)).toBe(7);
    expect(parse(id)[8] & 0xc0).toBe(0x80);
  });

  test('orders identifiers generated within the same millisecond', () => {
    vi.spyOn(Date, 'now').mockReturnValue(2_100_000_000_000);

    const first = uuidV7();
    const second = uuidV7();

    expect(second > first).toBe(true);
  });

  test('keeps identifiers ordered when the clock rolls back', () => {
    vi.spyOn(Date, 'now')
      .mockReturnValueOnce(2_200_000_000_000)
      .mockReturnValueOnce(2_199_999_999_000);

    const beforeRollback = uuidV7();
    const afterRollback = uuidV7();

    expect(afterRollback > beforeRollback).toBe(true);
  });
});
