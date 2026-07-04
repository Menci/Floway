import { describe, expect, test } from 'vitest';

import { applyRewrite, applyStops, completionsResponseBody, cursorAtBoundary, estimateCursorTabTokens, extractInsertion, parsePrefixSuffix } from './completions.ts';

describe('parsePrefixSuffix', () => {
  test('explicit OpenAI suffix field (no trimming)', () => {
    expect(parsePrefixSuffix('def f():\n    return ', '\n\nprint(f())')).toEqual({ prefix: 'def f():\n    return ', suffix: '\n\nprint(f())' });
  });
  test('StarCoder FIM tokens, byte-exact (keeps trailing space)', () => {
    expect(parsePrefixSuffix('<fim_prefix>def f():\n    return <fim_suffix>\n\nx<fim_middle>')).toEqual({ prefix: 'def f():\n    return ', suffix: '\n\nx' });
  });
  test('CodeLlama spaces are delimiters', () => {
    expect(parsePrefixSuffix('<PRE> A <SUF>B <MID>')).toEqual({ prefix: 'A', suffix: 'B' });
  });
  test('Qwen / DeepSeek / GLM triples', () => {
    expect(parsePrefixSuffix('<|fim_prefix|>P<|fim_suffix|>S<|fim_middle|>')).toEqual({ prefix: 'P', suffix: 'S' });
    expect(parsePrefixSuffix('<｜fim▁begin｜>P<｜fim▁hole｜>S<｜fim▁end｜>')).toEqual({ prefix: 'P', suffix: 'S' });
    expect(parsePrefixSuffix('<|code_prefix|>P<|code_suffix|>S<|code_middle|>')).toEqual({ prefix: 'P', suffix: 'S' });
  });
  test('Codestral reversed order', () => {
    expect(parsePrefixSuffix('[SUFFIX]S[PREFIX]P')).toEqual({ prefix: 'P', suffix: 'S' });
  });
  test('plain prompt → all prefix', () => {
    expect(parsePrefixSuffix('hello world')).toEqual({ prefix: 'hello world', suffix: '' });
  });
});

describe('cursorAtBoundary', () => {
  test('line/column at end of prefix', () => {
    expect(cursorAtBoundary('def f():\n    return ')).toEqual({ line: 1, column: 11 });
    expect(cursorAtBoundary('x')).toEqual({ line: 0, column: 1 });
  });
});

describe('applyRewrite', () => {
  test('replaces a single line (text ends in newline)', () => {
    expect(applyRewrite('a\nb\nc', { startLineNumber: 2, endLine: 3 }, 'B\n')).toBe('a\nB\nc');
  });
  test('no range → replaces the whole file verbatim', () => {
    expect(applyRewrite('a\nb', undefined, 'x\ny\n')).toBe('x\ny\n');
  });
  // Regressions for the observed Zed bugs: the replaced span must contain
  // exactly as many newlines as `text`, so the end line's inclusive/exclusive
  // ambiguity never swallows a following line or duplicates the last one.
  test('text without trailing newline does not duplicate the landing line', () => {
    // Restate lines 1-6 as-is (no trailing newline) over a 6-line-then-blanks file.
    const file = 'def f():\n    a = 1\n    b = 2\n    c = 3\n    d = 4\n    e = 5\n\n\nf()\n';
    const text = 'def f():\n    a = 1\n    b = 2\n    c = 3\n    d = 4\n    e = 5';
    expect(applyRewrite(file, { startLineNumber: 1, endLine: 6 }, text)).toBe(file);
  });
  test('text with trailing newline does not swallow the following blank line', () => {
    const file = 'def f():\n    a = 1\n    b = 2\n\n\nf()\n';
    const text = '    a = 1\n    b = 2\n';
    expect(applyRewrite(file, { startLineNumber: 2, endLine: 4 }, text)).toBe(file);
  });
  test('insertion (text longer than the span) does not eat the following line', () => {
    // Captured INS1: adding a route must preserve `export default routes;`.
    const file = "const routes = {\n  home: '/',\n  about: '/about',\n};\n\nexport default routes;\n";
    const text = "const routes = {\n  home: '/',\n  about: '/about',\n  contact: '/contact',\n};\n\n";
    const want = "const routes = {\n  home: '/',\n  about: '/about',\n  contact: '/contact',\n};\n\nexport default routes;\n";
    expect(applyRewrite(file, { startLineNumber: 1, endLine: 6 }, text)).toBe(want);
  });
});

describe('extractInsertion', () => {
  const ps = { prefix: 'def f():\n    return ', suffix: '\n\nprint(f())' };
  test('pure insertion when prefix + suffix are preserved', () => {
    // whole-file rewrite (no range) = the file with "a + b" inserted at cursor
    const text = 'def f():\n    return a + b\n\nprint(f())\n';
    expect(extractInsertion(ps, undefined, text)).toBe('a + b');
  });
  test('empty when the model rewrote the prefix (not a clean insertion)', () => {
    const text = 'def g():\n    return a + b\n\nprint(f())\n';
    expect(extractInsertion(ps, undefined, text)).toBe('');
  });
  test('empty text → empty insertion', () => {
    expect(extractInsertion(ps, undefined, '')).toBe('');
  });
});

describe('applyStops', () => {
  test('truncates at the first stop sequence', () => {
    expect(applyStops('a + b\ndef next', ['\ndef '])).toBe('a + b');
    expect(applyStops('a + b', undefined)).toBe('a + b');
    expect(applyStops('a\nb', '\n')).toBe('a');
  });
});

describe('estimateCursorTabTokens', () => {
  test('empty text → 0 (skip the min-1 floor)', () => {
    expect(estimateCursorTabTokens('', 'python')).toBe(0);
    expect(estimateCursorTabTokens('', 'markdown')).toBe(0);
  });
  test('non-empty text always yields at least 1 token', () => {
    expect(estimateCursorTabTokens('x', 'python')).toBe(1);
  });
  test('code ratio for code / unknown / empty languages (default 2.55 b/tok)', () => {
    // 1176 UTF-8 bytes / 2.55 → ceil = 462. Ratio calibrated against
    // aiserver.v1.AiService/CountTokens (probed 2026-07-03).
    const code = ('def f(n):\n    if n < 2: return n\n    a,b = 0,1\n'
                  + '    for _ in range(n-1): a,b = b,a+b\n    return b\n\n').repeat(12);
    const bytes = new TextEncoder().encode(code).length;
    const expected = Math.ceil(bytes / 2.55);
    expect(estimateCursorTabTokens(code, 'python')).toBe(expected);
    expect(estimateCursorTabTokens(code, 'typescript')).toBe(expected);
    expect(estimateCursorTabTokens(code, 'plaintext')).toBe(expected);
    expect(estimateCursorTabTokens(code, '')).toBe(expected);
  });
  test('prose ratio for markdown/txt (5.67 b/tok, case-insensitive)', () => {
    const prose = 'The quick brown fox jumps over the lazy dog. '.repeat(20);
    const bytes = new TextEncoder().encode(prose).length;
    const expected = Math.ceil(bytes / 5.67);
    expect(estimateCursorTabTokens(prose, 'markdown')).toBe(expected);
    expect(estimateCursorTabTokens(prose, 'Markdown')).toBe(expected);
    expect(estimateCursorTabTokens(prose, 'md')).toBe(expected);
    expect(estimateCursorTabTokens(prose, 'txt')).toBe(expected);
  });
  test('multi-byte characters count as their UTF-8 byte length', () => {
    // 6 UTF-8 bytes ('é' × 3) → ceil(6/2.55) = 3
    expect(estimateCursorTabTokens('ééé', 'python')).toBe(3);
  });
});

describe('completionsResponseBody', () => {
  test('emits an OpenAI text_completion with the caller-supplied usage', () => {
    const body = JSON.parse(completionsResponseBody('cursor-tab', 'hello', { promptTokens: 42, completionTokens: 7 }));
    expect(body).toMatchObject({
      object: 'text_completion',
      model: 'cursor-tab',
      choices: [{ text: 'hello', index: 0, finish_reason: 'stop', logprobs: null }],
      usage: { prompt_tokens: 42, completion_tokens: 7, total_tokens: 49 },
    });
  });
});
