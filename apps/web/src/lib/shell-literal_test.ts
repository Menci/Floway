import { describe, expect, it } from 'vitest';

import { posixShellLiteral, powerShellLiteral } from './shell-literal.ts';

describe('posixShellLiteral', () => {
  it('single-quotes and escapes embedded single quotes', () => {
    // A URL origin cannot carry a quote, but the encoder must stay safe for any
    // value: the quote is closed, backslash-escaped, and reopened.
    expect(posixShellLiteral("a'b")).toBe("'a'\\''b'");
  });

  it('wraps a plain origin in bare single quotes', () => {
    expect(posixShellLiteral('https://gateway.example')).toBe("'https://gateway.example'");
  });

  it('wraps an empty string in bare quotes', () => {
    expect(posixShellLiteral('')).toBe("''");
  });

  it('rejects a NUL character', () => {
    expect(() => posixShellLiteral('a\0b')).toThrow();
  });
});

describe('powerShellLiteral', () => {
  it('single-quotes and doubles embedded single quotes', () => {
    expect(powerShellLiteral("a'b")).toBe("'a''b'");
  });

  it('wraps a plain origin in bare single quotes', () => {
    expect(powerShellLiteral('http://localhost:8788')).toBe("'http://localhost:8788'");
  });

  it('wraps an empty string in bare quotes', () => {
    expect(powerShellLiteral('')).toBe("''");
  });

  it('rejects a NUL character', () => {
    expect(() => powerShellLiteral('a\0b')).toThrow();
  });
});
