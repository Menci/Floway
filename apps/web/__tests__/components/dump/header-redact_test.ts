import { expect, test } from 'vitest';

import { isSensitiveHeader, redactHeaderValue } from '../../../src/components/dump/header-redact.ts';

test('isSensitiveHeader matches the same set on both request and response sides', () => {
  // The list is shared by the request-side table and the response-side
  // table — `set-cookie` showing up as a response header must be redacted
  // just like `cookie` on the request side, otherwise an upstream that sets
  // a session cookie leaks through the dashboard.
  for (const name of ['authorization', 'cookie', 'set-cookie', 'proxy-authorization', 'x-api-key', 'x-goog-api-key']) {
    expect(isSensitiveHeader(name)).toBe(true);
    expect(isSensitiveHeader(name.toUpperCase())).toBe(true);
  }
});

test('isSensitiveHeader leaves non-credential headers untouched', () => {
  for (const name of ['content-type', 'content-length', 'x-trace-id', 'date']) {
    expect(isSensitiveHeader(name)).toBe(false);
  }
});

test('redactHeaderValue keeps first 8 + last 8 and replaces the middle with bullets at original length', () => {
  // 36-char token: 8 visible prefix + 20 bullets + 8 visible suffix.
  const token = 'sk-ant-api03-abcdefghijklmnopqr-ABCD';
  const out = redactHeaderValue(token);
  expect(out.length).toBe(token.length);
  expect(out.slice(0, 8)).toBe('sk-ant-a');
  expect(out.slice(-8)).toBe('pqr-ABCD');
  expect(out.slice(8, -8)).toBe('•'.repeat(token.length - 16));

  // 17-char value: the smallest input that still has a middle (8 + 1 + 8).
  expect(redactHeaderValue('1234567890ABCDEFG')).toBe('12345678•0ABCDEFG');
});

test('redactHeaderValue masks the whole value when there is no safe middle', () => {
  // Anything 16 chars or shorter has no middle — keeping any visible bytes
  // would leak the entire secret. Mask the whole value at its original
  // length so the visual mass still reflects the input.
  expect(redactHeaderValue('abc')).toBe('•••');
  expect(redactHeaderValue('1234567890ABCDEF')).toBe('••••••••••••••••');
  expect(redactHeaderValue('1234567890ABCDEF').length).toBe(16);
});
