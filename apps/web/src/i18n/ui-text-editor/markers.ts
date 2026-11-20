import type { PostProcessorModule } from 'i18next';

// Two zero-width characters form a binary channel invisible to layout while
// surviving string concatenation, interpolation, and attribute assignment.
// Each payload byte is encoded as 8 data bits plus a trailing 0 framing bit
// (9 code units per byte), and each token carries a 1-byte start/end tag,
// ASCII digits, and a trailing newline so incidental ZWNJ/ZWJ sequences
// (emoji, Arabic/Indic joining) are rejected by strict decoding.
const BIT_0 = '\u200C'; // ZWNJ
const BIT_1 = '\u200D'; // ZWJ

// Start token payload: `\x1E<id>\n`
// End token payload:   `\x1F<id>\n`
const START_TAG = 0x1E;
const END_TAG = 0x1F;
const PAYLOAD_END = 0x0A;

const encodeBytes = (bytes: number[]): string => {
  let out = '';
  for (const byte of bytes) {
    for (let bit = 7; bit >= 0; bit -= 1) {
      out += ((byte >> bit) & 1) === 1 ? BIT_1 : BIT_0;
    }
    out += BIT_0; // framing bit
  }
  return out;
};

const encodeToken = (tag: number, id: number): string => {
  const digits = String(id);
  const bytes: number[] = [tag];
  for (let i = 0; i < digits.length; i += 1) {
    bytes.push(digits.charCodeAt(i));
  }
  bytes.push(PAYLOAD_END);
  return encodeBytes(bytes);
};

// Matches one or more 9-char framed bytes where each frame ends with BIT_0.
const FRAMED_RUN_RE = new RegExp(`(?:[${BIT_0}${BIT_1}]{8}${BIT_0})+`, 'g');

const decodeFramedRun = (run: string): Array<{ kind: 'start' | 'end'; id: number }> | null => {
  const bytes: number[] = [];
  for (let i = 0; i < run.length; i += 9) {
    let value = 0;
    for (let b = 0; b < 8; b += 1) {
      value = (value << 1) | (run[i + b] === BIT_1 ? 1 : 0);
    }
    bytes.push(value);
  }

  const tokens: Array<{ kind: 'start' | 'end'; id: number }> = [];
  let cursor = 0;
  while (cursor < bytes.length) {
    const tag = bytes[cursor];
    if (tag !== START_TAG && tag !== END_TAG) return null;
    cursor += 1;
    let digits = '';
    while (cursor < bytes.length && bytes[cursor] !== PAYLOAD_END) {
      const code = bytes[cursor]!;
      if (code < 0x30 || code > 0x39) return null;
      digits += String.fromCharCode(code);
      cursor += 1;
    }
    if (cursor >= bytes.length || bytes[cursor] !== PAYLOAD_END || digits.length === 0) return null;
    cursor += 1;
    tokens.push({ kind: tag === START_TAG ? 'start' : 'end', id: Number(digits) });
  }
  return tokens;
};

export interface TextKeySegment {
  key: string;
  start: number;
  end: number;
}

interface ExtractedText {
  text: string;
  segments: TextKeySegment[];
  hadMarkers: boolean;
}

const entries: string[] = [];
const keyToId = new Map<string, number>();

const registerKey = (key: string): number => {
  const existing = keyToId.get(key);
  if (existing !== undefined) return existing;
  const id = entries.length;
  entries.push(key);
  keyToId.set(key, id);
  return id;
};

export const wrapWithKeyMarkers = (text: string, key: string): string => {
  const id = registerKey(key);
  return `${encodeToken(START_TAG, id)}${text}${encodeToken(END_TAG, id)}`;
};

const QUICK_MARKER_1 = `${BIT_0}${BIT_0}${BIT_0}`;
const QUICK_MARKER_2 = `${BIT_1}${BIT_0}${BIT_0}`;

export const mayContainKeyMarkers = (text: string): boolean =>
  text.includes(QUICK_MARKER_1) || text.includes(QUICK_MARKER_2);

export const extractKeySegments = (input: string): ExtractedText => {
  if (!mayContainKeyMarkers(input)) {
    return { text: input, segments: [], hadMarkers: false };
  }

  let clean = '';
  let lastIndex = 0;
  let hadMarkers = false;
  const openStack: Array<{ id: number; start: number }> = [];
  const segments: TextKeySegment[] = [];

  FRAMED_RUN_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = FRAMED_RUN_RE.exec(input)) !== null) {
    const tokens = decodeFramedRun(match[0]);
    if (!tokens) continue;
    hadMarkers = true;
    clean += input.slice(lastIndex, match.index);
    const offset = clean.length;
    for (const token of tokens) {
      if (token.kind === 'start') {
        openStack.push({ id: token.id, start: offset });
      } else {
        let matched = false;
        for (let i = openStack.length - 1; i >= 0; i -= 1) {
          if (openStack[i]!.id === token.id) {
            const opened = openStack.splice(i, 1)[0]!;
            const key = entries[token.id];
            if (key) {
              segments.push({
                key,
                start: opened.start,
                end: offset,
              });
            }
            matched = true;
            break;
          }
        }
        // <Trans> splits a single marked translation across elements, leaving
        // trailing text nodes with only the closing marker.
        if (!matched) {
          const key = entries[token.id];
          if (key) {
            segments.push({
              key,
              start: 0,
              end: offset,
            });
          }
        }
      }
    }
    lastIndex = match.index + match[0].length;
  }

  if (!hadMarkers) {
    return { text: input, segments: [], hadMarkers: false };
  }

  clean += input.slice(lastIndex);
  // Any unclosed marker (e.g. truncated text) spans to the end of the text.
  for (const opened of openStack) {
    const key = entries[opened.id];
    if (key) {
      segments.push({
        key,
        start: opened.start,
        end: clean.length,
      });
    }
  }

  // Order innermost / narrowest segments first so hit-testing prefers the
  // nested or exact translation over an enclosing template.
  segments.sort((a, b) => (a.end - a.start) - (b.end - b.start) || a.start - b.start);

  return { text: clean, segments, hadMarkers: true };
};

export const stripKeyMarkers = (input: string): string =>
  extractKeySegments(input).text;

// Tracking activates only after client hydration so the prerendered
// HydrateFallback shell reproduces index.html byte-for-byte.
let trackingActive = false;
let suppressDepth = 0;

export const setUiTextEditorTrackingActive = (active: boolean): void => {
  trackingActive = active;
};

/**
 * Runs a synchronous callback without attaching UI text editor markers to any
 * translations resolved inside it (used by the UI text editor's own UI and
 * non-DOM consumers such as document.title).
 */
export const withoutUiTextEditorMarkers = <T>(fn: () => T): T => {
  suppressDepth += 1;
  try {
    return fn();
  } finally {
    suppressDepth -= 1;
  }
};

export const UI_TEXT_EDITOR_POST_PROCESSOR_NAME = 'flowayUiTextEditor';

interface ResolvedInfo {
  exactUsedKey?: string;
  usedKey?: string;
}

export const uiTextEditorPostProcessor: PostProcessorModule = {
  type: 'postProcessor',
  name: UI_TEXT_EDITOR_POST_PROCESSOR_NAME,
  process(value, key, options) {
    if (!trackingActive || suppressDepth > 0) return value;
    if (value.length === 0) return value;
    const opt = options as { i18nResolved?: ResolvedInfo } | undefined;
    const exactKey = opt?.i18nResolved?.exactUsedKey ?? opt?.i18nResolved?.usedKey ?? (Array.isArray(key) ? key[0] : key);
    if (!exactKey) return value;
    return wrapWithKeyMarkers(value, exactKey);
  },
};
