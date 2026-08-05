import { describe, expect, it } from 'vitest';

import { typescriptString } from '../../scripts/typescript-string.ts';

describe('TypeScript string serialization', () => {
  it('round-trips every string shape used by generated source', async () => {
    const value = 'quotes: "\' | slash: \\ | controls: \0\b\f\n\r\t\u001f | separators: \u2028\u2029 | astral: \u{1f4a9} | lone high: \ud800 | lone low: \udc00';
    const serialized = typescriptString(value);

    expect(serialized).toMatch(/^'.*'$/s);
    expect(serialized).toContain('\\\'');
    expect(serialized).toContain('\\u2028');
    expect(serialized).toContain('\\u2029');
    expect(serialized).toContain('\\uD800');
    expect(serialized).toContain('\\uDC00');
    expect(serialized).toContain('\u{1f4a9}');

    const moduleUrl = `data:text/javascript;charset=utf-8,${encodeURIComponent(`export default ${serialized}`)}`;
    const literalModule: unknown = await import(/* @vite-ignore */ moduleUrl);
    if (typeof literalModule !== 'object' || literalModule === null || !('default' in literalModule)) {
      throw new TypeError('serialized literal module has no default export');
    }
    expect(literalModule.default).toBe(value);
  });
});
