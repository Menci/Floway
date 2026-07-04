import { describe, expect, test } from 'vitest';

import { detectPromptFormat, ZETA_END_MARKER } from './zeta-format.ts';
import { parseZetaV0615, renderV0615Output, streamCppInputForV0615 } from './zeta-v0615.ts';

// Faithful port of Zed's hashed_regions::write_snippet_with_markers: marker on
// its own line, block on the next; a `\n` is inserted after every non-final
// marker, and before a marker when the running output doesn't end in one.
const writeSnippet = (text: string, markers: { id: string; offset: number }[], cursor: { offset: number } | null): string => {
  let out = '';
  let cursorPlaced = false;
  for (let i = 0; i < markers.length; i++) {
    if (out.length > 0 && !out.endsWith('\n')) out += '\n';
    out += `<|marker_${markers[i].id}|>`;
    const next = markers[i + 1];
    if (next) {
      out += '\n';
      const block = text.slice(markers[i].offset, next.offset);
      if (cursor && !cursorPlaced && cursor.offset >= markers[i].offset && cursor.offset <= next.offset) {
        cursorPlaced = true;
        const c = cursor.offset - markers[i].offset;
        out += `${block.slice(0, c)}<|user_cursor|>${block.slice(c)}`;
      } else {
        out += block;
      }
    }
  }
  return out;
};

// Cursor file excerpt: three line-boundary blocks → markers at 0, o1, len.
const excerpt = 'fn a() {\n    x\n}\nfn b() {\n    y\n}\nfn c() {\n    z\n}\n';
const o1 = 'fn a() {\n    x\n}\n'.length;
const o2 = 'fn a() {\n    x\n}\nfn b() {\n    y\n}\n'.length;
const markers = [{ id: 'AAAA', offset: 0 }, { id: 'BBBB', offset: o1 }, { id: 'CCCC', offset: o2 }, { id: 'DDDD', offset: excerpt.length }];
const cursorOffset = 'fn a() {\n    x\n}\nfn b() {\n    y'.length; // after "y" in block 2

const relatedSnippet = writeSnippet('helper()\n', [{ id: 'ZZZZ', offset: 0 }, { id: 'YYYY', offset: 'helper()\n'.length }], null);
const cursorSnippet = writeSnippet(excerpt, markers, { offset: cursorOffset });
const v0615Prompt =
  `<[fim-suffix]><[fim-prefix]><filename>lib/util.rs\n${relatedSnippet}\n` +
  `<filename>src/main.rs\n${cursorSnippet}\n<[fim-middle]>`;

describe('detectPromptFormat / V0615', () => {
  test('hashed markers detected as V0615', () => {
    expect(detectPromptFormat(v0615Prompt)).toBe('zeta-v0615');
  });
});

describe('parseZetaV0615', () => {
  const p = parseZetaV0615(v0615Prompt)!;
  test('recovers both snippets and finds the cursor excerpt', () => {
    expect(p.snippets).toHaveLength(2);
    expect(p.snippets[p.cursorSnippetIx].path).toBe('src/main.rs');
  });
  test('reconstructs the cursor excerpt text byte-exact', () => {
    expect(p.snippets[p.cursorSnippetIx].text).toBe(excerpt);
  });
  test('recovers marker ids and clean-text offsets', () => {
    expect(p.snippets[p.cursorSnippetIx].markers).toEqual(markers);
  });
  test('cursor offset lands right after "y"', () => {
    expect(p.cursorOffset).toBe(cursorOffset);
    expect(p.snippets[p.cursorSnippetIx].text.slice(0, p.cursorOffset).endsWith('    y')).toBe(true);
  });
  test('non-cursor snippet parsed too', () => {
    const other = p.snippets.find(s => s.path === 'lib/util.rs')!;
    expect(other.text).toBe('helper()\n');
  });
});

describe('streamCppInputForV0615', () => {
  test('targets the cursor file with the excerpt as contents', () => {
    const p = parseZetaV0615(v0615Prompt)!;
    const input = streamCppInputForV0615(p, 'fast');
    expect(input.relativePath).toBe('src/main.rs');
    expect(input.contents).toBe(excerpt);
    expect(input.cursorLine).toBe(4); // 0-indexed line of "    y"
  });
});

describe('renderV0615Output', () => {
  const p = parseZetaV0615(v0615Prompt)!;
  // Rewrite line "    y" (file line 5) → "    y = 1;".
  const newExcerpt = excerpt.replace('    y\n', '    y = 1;\n');

  test('emits a marker-bounded span + end token, cursor at the change', () => {
    const out = renderV0615Output(p, { startLineNumber: 5, endLine: 6 }, '    y = 1;\n')!;
    expect(out.endsWith(ZETA_END_MARKER)).toBe(true);
    expect(out).toMatch(/^<\|marker_[A-Z]{4}\|>\n/);
    expect(out).toContain('<|user_cursor|>');
  });

  test('a simulated Zed parse (id→offset lookup, replace span) reconstructs the new excerpt', () => {
    const out = renderV0615Output(p, { startLineNumber: 5, endLine: 6 }, '    y = 1;\n')!;
    const body = out.slice(0, out.length - ZETA_END_MARKER.length);
    // pair the two markers, take content between them, strip a leading newline + cursor
    const tags = [...body.matchAll(/<\|marker_([A-Z]{4})\|>/g)];
    expect(tags.length).toBe(2);
    const [startTag, endTag] = tags;
    let span = body.slice(startTag.index! + startTag[0].length, endTag.index!);
    span = span.replace(/^\n/, '').replace('<|user_cursor|>', '');
    const byId = Object.fromEntries(markers.map(m => [m.id, m.offset]));
    const startByte = byId[startTag[1]];
    const endByte = byId[endTag[1]];
    // Zed normalizes: old span ends with \n, keep span's trailing \n.
    const oldSpan = excerpt.slice(startByte, endByte);
    if (oldSpan.endsWith('\n') && !span.endsWith('\n') && span.length > 0) span += '\n';
    const rebuilt = excerpt.slice(0, startByte) + span + excerpt.slice(endByte);
    expect(rebuilt).toBe(newExcerpt);
  });

  test('unchanged excerpt → null', () => {
    expect(renderV0615Output(p, { startLineNumber: 5, endLine: 6 }, '    y\n')).toBeNull();
  });
});
