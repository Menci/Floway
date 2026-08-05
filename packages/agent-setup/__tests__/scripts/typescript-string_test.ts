import { describe, expect, it } from 'vitest';

import { typescriptString } from '../../scripts/typescript-string.ts';

const importLiteral = async (serialized: string): Promise<unknown> => {
  const moduleUrl = `data:text/javascript;charset=utf-8,${encodeURIComponent(`export default ${serialized}`)}`;
  const literalModule: unknown = await import(/* @vite-ignore */ moduleUrl);
  if (typeof literalModule !== 'object' || literalModule === null || !('default' in literalModule)) {
    throw new TypeError('serialized literal module has no default export');
  }
  return literalModule.default;
};

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
    expect(await importLiteral(serialized)).toBe(value);
  });

  it('escapes every C0 control instead of writing control bytes into source', async () => {
    const value = Array.from({ length: 0x20 }, (_, codePoint) => String.fromCharCode(codePoint)).join('');
    const serialized = typescriptString(value);

    expect(serialized).not.toMatch(/[\u0000-\u001f]/);
    expect(serialized).toContain('\\u001f');
    expect(await importLiteral(serialized)).toBe(value);
  });

  it('round-trips a NUL immediately followed by a decimal digit', async () => {
    const value = '\u00001';
    const serialized = typescriptString(value);

    expect(serialized).not.toMatch(/[\u0000-\u001f]/);
    expect(serialized).toBe('\'\\u00001\'');
    expect(await importLiteral(serialized)).toBe(value);
  });
});
