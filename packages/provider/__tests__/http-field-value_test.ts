import { expect, test, vi } from 'vitest';

import { isHttpFieldValue } from '../src/http-field-value.ts';

test('isHttpFieldValue preserves RFC field-value byte boundaries', () => {
  expect(isHttpFieldValue('')).toBe(true);
  expect(isHttpFieldValue('\u0009\u0020\u007e\u0080\u00ff')).toBe(true);
  for (const invalid of ['\u0000', '\u0008', '\u000a', '\u001f', '\u007f', '\u0100', '\ud800', '😀']) {
    expect(isHttpFieldValue(invalid)).toBe(false);
  }
});

test('isHttpFieldValue scans string code units without materializing its iterator', () => {
  const iterator = vi.spyOn(String.prototype, Symbol.iterator).mockImplementation(() => {
    throw new Error('string iterator must not be consumed');
  });
  let valid: boolean;
  try {
    valid = isHttpFieldValue('header-value');
  } finally {
    iterator.mockRestore();
  }
  expect(valid).toBe(true);
});
