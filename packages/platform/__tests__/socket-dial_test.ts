import { expect, it } from 'vitest';

import { normalizeDialHost } from '../src/socket-dial.ts';

it('normalizeDialHost strips brackets around an IPv6 literal', () => {
  expect(normalizeDialHost('[2001:db8::1]')).toBe('2001:db8::1');
  expect(normalizeDialHost('api.example.com')).toBe('api.example.com');
});
