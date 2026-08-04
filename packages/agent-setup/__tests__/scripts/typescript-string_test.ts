import { describe, expect, it } from 'vitest';

import { typescriptString } from '../../scripts/typescript-string.ts';

describe('TypeScript string serialization', () => {
  it('round-trips every string shape used by generated source', () => {
    const value = 'quotes: "\' | slash: \\ | controls: \0\b\f\n\r\t\u001f | separators: \u2028\u2029 | astral: \u{1f4a9} | lone high: \ud800 | lone low: \udc00';

    expect(JSON.parse(typescriptString(value))).toBe(value);
  });
});
