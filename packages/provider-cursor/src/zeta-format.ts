/**
 * Zed edit-prediction marker formats over /v1/completions.
 *
 * Zed's open_ai_compatible edit-prediction provider sends a rendered prompt (no
 * explicit format field) and expects marker-delimited text back. We detect the
 * format from the prompt tokens and, for Zeta 2.1 (V0318 SeedMultiRegions),
 * parse the editable region + cursor + edit history into a StreamCpp request,
 * then render Cursor's rewritten file back as a `<|marker_1|>…<|marker_K|>` span.
 *
 * V0318 layout (SPM order), byte-exact per Zed's `zeta_prompt` crate:
 *   <[fim-suffix]>{file suffix}\n<[fim-prefix]>{diagnostics}{<filename>PATH\n
 *   {related-file excerpts}}{<filename>edit_history\n{diffs}}<filename>{target}\n
 *   {code before region}<|marker_1|>{block_1}<|marker_2|>{block_2}…<|marker_K|>\n
 *   <[fim-middle]>
 * The numbered markers are separators partitioning the editable region into K
 * blocks at line boundaries — a marker is immediately followed by its block
 * (no newline). `<|user_cursor|>` sits inside exactly one block.
 *
 * Output (what the model — and therefore we — emit): the rewritten region as
 * `<|marker_1|>{new region, with <|user_cursor|>}<|marker_K|>` + end token. Zed
 * maps the first/last output marker to `marker_offsets[value-1]` and replaces
 * that span of the old region; using marker_1..marker_K replaces the whole
 * region with the reconstructed new text.
 */

import { applyRewrite } from './completions.ts';
import type { StreamCppLineRange, StreamCppRequestInput } from './proto/stream-cpp.ts';

const FIM_SUFFIX = '<[fim-suffix]>';
const FIM_PREFIX = '<[fim-prefix]>';
const FIM_MIDDLE = '<[fim-middle]>';
const FILENAME = '<filename>';
const CURSOR = '<|user_cursor|>';
// U+2581 (LOWER ONE EIGHTH BLOCK) inside the seed end-of-sentence token.
export const ZETA_END_MARKER = '<[end▁of▁sentence]>';

const MARKER_RE = /<\|marker_([0-9A-Za-z_-]+)\|>/g;
const numericMarker = (id: string): boolean => /^\d+$/.test(id);

export type PromptFormat = 'zeta-v0318' | 'zeta-v0615' | 'fim' | 'plain';

// Zed sends no format field; infer from the prompt body. The Zeta formats carry
// the fim-middle section token plus region markers — numeric ids for V0318,
// hashed ids for V0615. FIM carries a fill-in-the-middle token triple;
// everything else is a plain prefix.
export const detectPromptFormat = (prompt: string): PromptFormat => {
  if (prompt.includes(FIM_MIDDLE) && prompt.includes('<|marker_')) {
    const ids = [...prompt.matchAll(MARKER_RE)].map(m => m[1]);
    if (ids.length > 0 && ids.every(numericMarker)) return 'zeta-v0318';
    return 'zeta-v0615';
  }
  if (/<\|fim_prefix\|>|<fim_prefix>|<｜fim▁begin｜>|<\|code_prefix\|>|<PRE> |\[PREFIX\]/.test(prompt)) return 'fim';
  return 'plain';
};

export interface ParsedZeta {
  targetPath: string;
  /** Full reconstructed file contents (cursor marker removed). */
  contents: string;
  /** File text before the editable region (byte-exact). */
  codeBefore: string;
  /** Editable region text (all markers + cursor removed). */
  editable: string;
  /** File text after the editable region (byte-exact, as the suffix section). */
  codeAfter: string;
  cursorLine: number;
  cursorColumn: number;
  /** Number of region markers K — the output's closing marker is marker_K. */
  markerCount: number;
  diffHistory: string[];
}

// Walk a region, dropping every `<|marker_N|>` separator and the `<|user_cursor|>`
// tag, recording where the cursor landed in the cleaned text.
const stripRegionMarkers = (region: string): { editable: string; cursorOffset: number | null } => {
  let out = '';
  let cursor: number | null = null;
  let i = 0;
  while (i < region.length) {
    if (region.startsWith(CURSOR, i)) { cursor = out.length; i += CURSOR.length; continue; }
    if (region[i] === '<') {
      const m = /^<\|marker_[0-9A-Za-z_-]+\|>/.exec(region.slice(i));
      if (m) { i += m[0].length; continue; }
    }
    out += region[i];
    i += 1;
  }
  return { editable: out, cursorOffset: cursor };
};

// Parse a Zeta V0318 prompt into the pieces needed to build a StreamCpp request.
// Returns null when the prompt isn't a well-formed single-target Zeta prompt
// (the caller then falls back to the FIM/plain path).
export const parseZetaV0318 = (prompt: string): ParsedZeta | null => {
  const midIdx = prompt.indexOf(FIM_MIDDLE);
  if (midIdx < 0) return null;
  const body = prompt.slice(0, midIdx);

  const sufIdx = body.indexOf(FIM_SUFFIX);
  const preIdx = body.indexOf(FIM_PREFIX);
  if (sufIdx < 0 || preIdx < 0 || preIdx < sufIdx) return null;

  // Suffix section body is `{file suffix}` verbatim (Zed appends a trailing
  // newline when the file suffix lacks one); we reuse it verbatim so the
  // reconstruct/extract round-trip stays self-consistent.
  const codeAfter = body.slice(sufIdx + FIM_SUFFIX.length, preIdx);
  const prefixSection = body.slice(preIdx + FIM_PREFIX.length);

  // File sections: `<filename>PATH\n{content}` repeated. edit_history is one of
  // them; the target file is the section carrying the region markers.
  let target: { path: string; content: string } | null = null;
  const diffHistory: string[] = [];
  for (const part of prefixSection.split(FILENAME)) {
    if (part.length === 0) continue;
    const nl = part.indexOf('\n');
    const path = nl >= 0 ? part.slice(0, nl) : part;
    const content = nl >= 0 ? part.slice(nl + 1) : '';
    if (path === 'edit_history') { const d = content.replace(/\n$/, ''); if (d.trim().length > 0) diffHistory.push(d); continue; }
    if (content.includes('<|marker_')) target = { path, content };
  }
  if (!target) return null;

  // Locate the first and last region markers. codeBefore is everything up to
  // marker_1; the editable region is between marker_1 and marker_K (the final
  // marker sits at the region end with no block after it).
  const markers = [...target.content.matchAll(MARKER_RE)];
  if (markers.length < 2) return null;
  const first = markers[0];
  const last = markers[markers.length - 1];
  const codeBefore = target.content.slice(0, first.index);
  const regionBetween = target.content.slice(first.index + first[0].length, last.index);
  const { editable, cursorOffset } = stripRegionMarkers(regionBetween);

  const contents = codeBefore + editable + codeAfter;
  const beforeCursor = codeBefore + editable.slice(0, cursorOffset ?? editable.length);
  const lines = beforeCursor.split('\n');

  return {
    targetPath: target.path,
    contents,
    codeBefore,
    editable,
    codeAfter,
    cursorLine: lines.length - 1,
    cursorColumn: lines[lines.length - 1].length,
    markerCount: markers.length,
    diffHistory,
  };
};

export const streamCppInputForZeta = (parsed: ParsedZeta, modelName: string): StreamCppRequestInput => ({
  relativePath: parsed.targetPath,
  contents: parsed.contents,
  cursorLine: parsed.cursorLine,
  cursorColumn: parsed.cursorColumn,
  languageId: '',
  modelName,
  ...(parsed.diffHistory.length > 0 ? { diffHistory: parsed.diffHistory } : {}),
});

// Applying StreamCpp's rewritten-region text to the whole file is the same
// operation used by the FIM path — see applyRewrite in completions.ts.

export const commonPrefixLen = (a: string, b: string): number => { let i = 0; while (i < a.length && i < b.length && a[i] === b[i]) i++; return i; };
export const commonSuffixLen = (a: string, b: string, cap: number): number => { let i = 0; while (i < cap && a[a.length - 1 - i] === b[b.length - 1 - i]) i++; return i; };

// Offset in `newText` at the end of the change vs `oldText` (after the common
// prefix / before the common suffix). A lone trailing-newline difference is
// ignored first — Cursor's rewrite often drops the region's final newline, and
// letting that zero the common suffix would push the cursor to the very end of
// the region (past the real edit). Exported for the V0615 renderer.
export const cursorAtChangeEnd = (oldText: string, newText: string): number => {
  const o = oldText.endsWith('\n') ? oldText.slice(0, -1) : oldText;
  const n = newText.endsWith('\n') ? newText.slice(0, -1) : newText;
  const cp = commonPrefixLen(o, n);
  const cs = commonSuffixLen(o, n, Math.min(o.length, n.length) - cp);
  return n.length - cs;
};

// Render Cursor's edit as a Zeta V0318 output span. Applies Cursor's
// (text, range_to_replace) to the file, extracts the new editable region (must
// preserve codeBefore/codeAfter — otherwise Cursor edited outside the region),
// places <|user_cursor|> at the end of the change, and emits
// `<|marker_1|>{new region}<|marker_K|>` + end token. Returns null when there
// is no in-region change (Zed then shows no suggestion).
export const renderZetaV0318Output = (parsed: ParsedZeta, range: StreamCppLineRange | undefined, text: string): string | null => {
  if (!text) return null;
  const newFile = applyRewrite(parsed.contents, range, text);
  if (!newFile.startsWith(parsed.codeBefore)) return null;
  let newEditable = newFile.slice(parsed.codeBefore.length);
  if (parsed.codeAfter.length > 0) {
    if (!newEditable.endsWith(parsed.codeAfter)) return null;
    newEditable = newEditable.slice(0, newEditable.length - parsed.codeAfter.length);
  }
  if (newEditable === parsed.editable) return null;

  const cursorAt = cursorAtChangeEnd(parsed.editable, newEditable);
  const withCursor = newEditable.slice(0, cursorAt) + CURSOR + newEditable.slice(cursorAt);

  return `<|marker_1|>${withCursor}<|marker_${parsed.markerCount}|>${ZETA_END_MARKER}`;
};
