import { describe, expect, test } from 'vitest';

import { detectPromptFormat, parseZetaV0318, renderZetaV0318Output, streamCppInputForZeta, ZETA_END_MARKER } from './zeta-format.ts';

// A byte-exact V0318 prompt in the shape Zed's zeta_prompt crate emits: SPM
// order, markers as separators (marker immediately followed by its block),
// `<|user_cursor|>` inside one block, target section carries the markers.
const codeBefore = 'fn main() {\n';
const block1 = '    let a = 1;\n    let b = 2;\n';
const block2 = '    let c = a<|user_cursor|>\n}\n';
const editable = '    let a = 1;\n    let b = 2;\n    let c = a\n}\n';
const zetaPrompt =
  '<[fim-suffix]>\n<[fim-prefix]><filename>lib/helper.rs\nfn helper() {}\n' +
  '<filename>edit_history\n--- a/src/main.rs\n+++ b/src/main.rs\n-let a=0;\n+let a = 1;\n' +
  `<filename>src/main.rs\n${codeBefore}<|marker_1|>${block1}<|marker_2|>${block2}<|marker_3|>\n<[fim-middle]>`;

describe('detectPromptFormat', () => {
  test('V0318 numeric markers', () => {
    expect(detectPromptFormat(zetaPrompt)).toBe('zeta-v0318');
  });
  test('V0615 hashed markers', () => {
    expect(detectPromptFormat('<[fim-prefix]><|marker_aB3_|>x<|marker_9Zq-|><[fim-middle]>')).toBe('zeta-v0615');
  });
  test('FIM triple', () => {
    expect(detectPromptFormat('<fim_prefix>a<fim_suffix>b<fim_middle>')).toBe('fim');
  });
  test('plain prompt', () => {
    expect(detectPromptFormat('def f():\n    return ')).toBe('plain');
  });
});

describe('parseZetaV0318', () => {
  const p = parseZetaV0318(zetaPrompt)!;
  test('extracts the target section path', () => {
    expect(p.targetPath).toBe('src/main.rs');
  });
  test('reconstructs codeBefore / editable / codeAfter and marker count', () => {
    expect(p.codeBefore).toBe(codeBefore);
    expect(p.editable).toBe(editable); // markers + cursor stripped
    expect(p.codeAfter).toBe('\n'); // suffix section body (Zed's appended newline)
    expect(p.markerCount).toBe(3);
    expect(p.contents).toBe(`${codeBefore}${editable}\n`);
  });
  test('cursor lands right after "let c = a"', () => {
    const lineText = p.contents.split('\n')[p.cursorLine];
    expect(lineText).toBe('    let c = a');
    expect(p.cursorColumn).toBe('    let c = a'.length);
  });
  test('captures edit history', () => {
    expect(p.diffHistory).toHaveLength(1);
    expect(p.diffHistory[0]).toContain('+let a = 1;');
  });
  test('non-Zeta prompt returns null', () => {
    expect(parseZetaV0318('<fim_prefix>a<fim_suffix>b<fim_middle>')).toBeNull();
  });
});

describe('streamCppInputForZeta', () => {
  test('builds a StreamCpp request from the parsed region', () => {
    const p = parseZetaV0318(zetaPrompt)!;
    const input = streamCppInputForZeta(p, 'fast');
    expect(input.relativePath).toBe('src/main.rs');
    expect(input.contents).toBe(p.contents);
    expect(input.modelName).toBe('fast');
    expect(input.diffHistory).toHaveLength(1);
  });
});

describe('renderZetaV0318Output', () => {
  const p = parseZetaV0318(zetaPrompt)!;
  // Editable region occupies file lines 2..5. Cursor's end line co-varies with
  // text's trailing newline; the splice keys off newline counts, not this value.
  const startLine = codeBefore.split('\n').length; // 2
  const editableLines = editable.endsWith('\n') ? editable.split('\n').length - 1 : editable.split('\n').length;
  const endLine = startLine + editableLines; // Cursor's end line for a full-region rewrite

  test('emits marker_1…marker_K span with the rewritten region + cursor + end token', () => {
    const newEditable = editable.replace('let c = a', 'let c = a + b;');
    const out = renderZetaV0318Output(p, { startLineNumber: startLine, endLine }, newEditable)!;
    expect(out.startsWith('<|marker_1|>')).toBe(true);
    expect(out.endsWith(`<|marker_3|>${ZETA_END_MARKER}`)).toBe(true);
    expect(out).toContain('<|user_cursor|>');
    // Zed replaces the whole region with the content between marker_1 and
    // marker_K (cursor marker stripped) — must equal our new region.
    const inner = out.slice('<|marker_1|>'.length, out.lastIndexOf('<|marker_3|>'));
    expect(inner.replace('<|user_cursor|>', '')).toBe(newEditable);
  });

  test('cursor marker sits at the end of the change span', () => {
    const newEditable = editable.replace('let c = a', 'let c = a + b;');
    const out = renderZetaV0318Output(p, { startLineNumber: startLine, endLine }, newEditable)!;
    expect(out).toContain('let c = a + b;<|user_cursor|>');
  });

  test('no in-region change → null (no suggestion)', () => {
    const out = renderZetaV0318Output(p, { startLineNumber: startLine, endLine }, editable);
    expect(out).toBeNull();
  });

  test('edit outside the region (breaks codeBefore) → null', () => {
    // Rewrite the whole file changing codeBefore — codeAfter/codeBefore no longer match.
    const out = renderZetaV0318Output(p, { startLineNumber: 1, endLine: 2 }, 'fn changed() {');
    expect(out).toBeNull();
  });

  test('empty text → null', () => {
    expect(renderZetaV0318Output(p, undefined, '')).toBeNull();
  });

  test('multi-line insertion: preserves the trailing line and places the cursor after the inserted line', () => {
    // Captured INS1 shape: object literal gains a new entry; the region rewrite
    // spans the object, text ends in a newline. Cursor must not jump past `};`.
    const cb = 'const routes = {\n';
    const ca = '\nexport default routes;\n';
    const prompt =
      `<[fim-suffix]>\n${ca}<[fim-prefix]><filename>r.js\n` +
      '<filename>edit_history\n--- a/r.js\n+++ b/r.js\n@@\n home\n+ x\n' +
      `<filename>r.js\n${cb}<|marker_1|>  home: '/',\n  about: '/about',<|user_cursor|>\n};\n<|marker_2|>\n<[fim-middle]>`;
    const parsed = parseZetaV0318(prompt)!;
    const text = "const routes = {\n  home: '/',\n  about: '/about',\n  contact: '/contact',\n};\n\n";
    const out = renderZetaV0318Output(parsed, { startLineNumber: 1, endLine: 6 }, text)!;
    // cursor sits before `};`, after the inserted `  contact: '/contact',` line
    expect(out).toContain("  contact: '/contact',\n<|user_cursor|>};");
    // the region rewrite (cursor stripped) is the new object body (region keeps its trailing newline)
    const inner = out.slice('<|marker_1|>'.length, out.lastIndexOf('<|marker_2|>')).replace('<|user_cursor|>', '');
    expect(inner).toBe("  home: '/',\n  about: '/about',\n  contact: '/contact',\n};\n");
  });
});
