import { describe, expect, test } from 'vitest';

import { generateSessionToken } from './session-tokens.ts';

describe('session-tokens', () => {
  test('generateSessionToken returns 64 lowercase hex characters', () => {
    const token = generateSessionToken();
    expect(token).toMatch(/^[0-9a-f]{64}$/);
  });

  test('successive tokens differ', () => {
    expect(generateSessionToken()).not.toBe(generateSessionToken());
  });
});
