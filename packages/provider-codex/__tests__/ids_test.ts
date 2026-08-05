import { parse, validate, version } from 'uuid';
import { afterEach, describe, expect, test, vi } from 'vitest';

import { sha256Uuid, uuidV7 } from '../src/ids.ts';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('sha256Uuid', () => {
  test('preserves the established SHA-256 to UUIDv4 mapping', async () => {
    expect(await sha256Uuid('hello')).toBe('2cf24dba-5fb0-430e-a6e8-3b2ac5b9e29e');
  });

  test('stamps RFC version and variant bits', async () => {
    const id = await sha256Uuid('version-and-variant');

    expect(validate(id)).toBe(true);
    expect(version(id)).toBe(4);
    expect(parse(id)[8] & 0xc0).toBe(0x80);
  });
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
