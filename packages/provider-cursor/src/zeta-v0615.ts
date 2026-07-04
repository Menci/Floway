/**
 * Zeta V0615 hashed-regions edit-prediction format (cross-file capable).
 *
 * Not reachable from Zed's GUI `prompt_format` menu, but implemented for
 * completeness and for custom clients: it is the only Zeta format whose markers
 * are content-hashed and addressable across every related-file excerpt, so a
 * prediction can target a file other than the cursor's.
 *
 * Prompt layout (per Zed's `hashed_regions`): all context lives in the prefix
 * block; each excerpt is `<filename>PATH\n` then, for K region markers,
 *   <|marker_h0|>\n{block_0}<|marker_h1|>\n{block_1}…<|marker_h{K-1}|>
 * where a marker is written on its own line and its block follows on the next
 * line (the writer inserts a `\n` after every non-final marker; interior blocks
 * already end in `\n`). `<|user_cursor|>` sits inside one block of the cursor
 * file. Marker ids are content hashes — we never recompute them: Zed rebuilds
 * the same marker table deterministically when parsing our output, so we echo
 * the prompt's ids verbatim and let Zed resolve them to byte offsets.
 *
 * Output (what the model emits, one block per edited span):
 *   <|marker_start|>\n{new span, optional <|user_cursor|>}\n<|marker_end|>
 * blocks joined by `\n`, then the seed end token. Zed pairs markers two at a
 * time, looks each id up in its table, and replaces old_text[start..end] with
 * the span — normalizing boundary newlines — so our span need only be the
 * correct new text for the bracketed range.
 */

import { applyRewrite } from './completions.ts';
import type { StreamCppLineRange, StreamCppRequestInput } from './proto/stream-cpp.ts';
import { commonPrefixLen, commonSuffixLen, cursorAtChangeEnd, ZETA_END_MARKER } from './zeta-format.ts';

const FIM_PREFIX = '<[fim-prefix]>';
const FIM_MIDDLE = '<[fim-middle]>';
const FILENAME = '<filename>';
const CURSOR = '<|user_cursor|>';
const MARKER_RE = /<\|marker_([0-9A-Za-z_-]+)\|>/g;

const markerTag = (id: string): string => `<|marker_${id}|>`;

export interface V0615Marker { id: string; offset: number }
export interface V0615Snippet { path: string; text: string; markers: V0615Marker[] }
export interface ParsedV0615 {
  snippets: V0615Snippet[];
  cursorSnippetIx: number;
  cursorOffset: number;
  diffHistory: string[];
}

const stripOneLeadingNewline = (s: string): string => (s.startsWith('\n') ? s.slice(1) : s);

// Recover a snippet's clean excerpt text, its ordered markers (id + offset into
// the clean text), and the cursor offset, from the rendered `<filename>` body.
const parseSnippetContent = (content: string): { text: string; markers: V0615Marker[]; cursor: number | null } => {
  const ids: string[] = [];
  const parts: string[] = [];
  let prev = 0;
  MARKER_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = MARKER_RE.exec(content)) !== null) {
    ids.push(m[1]);
    parts.push(content.slice(prev, m.index));
    prev = MARKER_RE.lastIndex;
  }
  parts.push(content.slice(prev));

  const markers: V0615Marker[] = [];
  let text = '';
  let cursor: number | null = null;
  for (let i = 0; i < ids.length; i++) {
    markers.push({ id: ids[i], offset: text.length });
    if (i < ids.length - 1) {
      // Block that follows marker i is parts[i + 1] with the writer's inserted
      // newline stripped. Interior blocks retain their own trailing newline.
      const block = stripOneLeadingNewline(parts[i + 1]);
      const ci = block.indexOf(CURSOR);
      if (ci >= 0) {
        cursor = text.length + ci;
        text += block.slice(0, ci) + block.slice(ci + CURSOR.length);
      } else {
        text += block;
      }
    }
  }
  return { text, markers, cursor };
};

// Parse a V0615 prompt into per-file snippets, the cursor location, and edit
// history. Returns null when there is no cursor-bearing excerpt.
export const parseZetaV0615 = (prompt: string): ParsedV0615 | null => {
  const midIdx = prompt.indexOf(FIM_MIDDLE);
  const preIdx = prompt.indexOf(FIM_PREFIX);
  if (midIdx < 0 || preIdx < 0 || preIdx > midIdx) return null;
  const prefixSection = prompt.slice(preIdx + FIM_PREFIX.length, midIdx);

  const snippets: V0615Snippet[] = [];
  const diffHistory: string[] = [];
  let cursorSnippetIx = -1;
  let cursorOffset = 0;
  for (const part of prefixSection.split(FILENAME)) {
    if (part.length === 0) continue;
    const nl = part.indexOf('\n');
    const path = nl >= 0 ? part.slice(0, nl) : part;
    const content = nl >= 0 ? part.slice(nl + 1) : '';
    if (path === 'edit_history') { const d = content.replace(/\n$/, ''); if (d.trim().length > 0) diffHistory.push(d); continue; }
    if (!content.includes('<|marker_')) continue;
    const parsed = parseSnippetContent(content);
    if (parsed.cursor !== null) { cursorSnippetIx = snippets.length; cursorOffset = parsed.cursor; }
    snippets.push({ path, text: parsed.text, markers: parsed.markers });
  }
  if (cursorSnippetIx < 0) return null;
  return { snippets, cursorSnippetIx, cursorOffset, diffHistory };
};

export const streamCppInputForV0615 = (parsed: ParsedV0615, modelName: string): StreamCppRequestInput => {
  const snip = parsed.snippets[parsed.cursorSnippetIx];
  const before = snip.text.slice(0, parsed.cursorOffset).split('\n');
  return {
    relativePath: snip.path,
    contents: snip.text,
    cursorLine: before.length - 1,
    cursorColumn: before[before.length - 1].length,
    languageId: '',
    modelName,
    ...(parsed.diffHistory.length > 0 ? { diffHistory: parsed.diffHistory } : {}),
  };
};

// The StreamCpp splice + common-prefix/suffix scan are shared with the FIM +
// V0318 paths — see applyRewrite / commonPrefixLen / commonSuffixLen in
// completions.ts and zeta-format.ts.

// Port of hashed_regions::encode_from_old_and_new: pick the marker pair that
// brackets the single contiguous change (common prefix/suffix), emit the new
// span between them with the cursor inserted if it lands inside.
const encodeFromOldAndNew = (oldText: string, newText: string, markers: V0615Marker[], cursorInNew: number | null): string => {
  const cp = commonPrefixLen(oldText, newText);
  const cs = commonSuffixLen(oldText, newText, Math.min(oldText.length, newText.length) - cp);
  const changeEndInOld = oldText.length - cs;

  let startIx = 0;
  for (let i = 0; i < markers.length; i++) if (markers[i].offset <= cp) startIx = i;
  let endIx = markers.length - 1;
  for (let i = 0; i < markers.length; i++) if (markers[i].offset >= changeEndInOld) { endIx = i; break; }
  if (startIx === endIx) {
    if (endIx < markers.length - 1) endIx += 1;
    else if (startIx > 0) startIx -= 1;
  }

  const oldEnd = markers[endIx].offset;
  const newStart = markers[startIx].offset;
  const newEnd = newText.length - (oldText.length - oldEnd);
  const newSpan = newText.slice(newStart, newEnd);

  let result = `${markerTag(markers[startIx].id)}\n`;
  if (cursorInNew !== null && cursorInNew >= newStart && cursorInNew <= newEnd) {
    const c = cursorInNew - newStart;
    result += newSpan.slice(0, c) + CURSOR + newSpan.slice(c);
  } else {
    result += newSpan;
  }
  if (!result.endsWith('\n')) result += '\n';
  result += markerTag(markers[endIx].id);
  return result;
};

// Render Cursor's edit to the cursor-file excerpt as a V0615 hashed-region
// span. Returns null when the excerpt is unchanged or has too few markers.
export const renderV0615Output = (parsed: ParsedV0615, range: StreamCppLineRange | undefined, text: string): string | null => {
  if (!text) return null;
  const snip = parsed.snippets[parsed.cursorSnippetIx];
  if (snip.markers.length < 2) return null;
  const oldText = snip.text;
  const newText = applyRewrite(oldText, range, text);
  if (newText === oldText) return null;

  const cursorInNew = cursorAtChangeEnd(oldText, newText); // trailing-newline-insensitive
  return encodeFromOldAndNew(oldText, newText, snip.markers, cursorInNew) + ZETA_END_MARKER;
};
