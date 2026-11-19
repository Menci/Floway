import type { PostProcessorModule } from 'i18next';

// Two zero-width characters form a binary channel invisible to layout while
// surviving string concatenation, interpolation, and attribute assignment.
// Every byte is framed with a trailing 0 bit (9 code units per byte) and every
// token starts with a 2-byte sentinel so incidental ZWNJ/ZWJ in real copy
// (emoji sequences, Arabic/Indic joining) cannot be mistaken for a marker.
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
  if (run.length % 9 !== 0) return null;
  const bytes: number[] = [];
  for (let i = 0; i < run.length; i += 9) {
    if (run[i + 8] !== BIT_0) return null;
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
  return tokens.length > 0 ? tokens : null;
};

export interface RegisteredKeyEntry {
  key: string;
  baseKey: string;
}

export interface TextKeySegment {
  key: string;
  baseKey: string;
  start: number;
  end: number;
}

export interface ExtractedText {
  text: string;
  segments: TextKeySegment[];
  hadMarkers: boolean;
}

const entries: RegisteredKeyEntry[] = [];
const keyToId = new Map<string, number>();

export const registerKey = (key: string, baseKey: string): number => {
  const signature = `${key}\0${baseKey}`;
  const existing = keyToId.get(signature);
  if (existing !== undefined) return existing;
  const id = entries.length;
  entries.push({ key, baseKey });
  keyToId.set(signature, id);
  return id;
};

export const lookupKey = (id: number): RegisteredKeyEntry | undefined => entries[id];

export const wrapWithKeyMarkers = (text: string, key: string, baseKey: string): string => {
  const id = registerKey(key, baseKey);
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
            const meta = entries[token.id];
            if (meta) {
              segments.push({
                key: meta.key,
                baseKey: meta.baseKey,
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
          const meta = entries[token.id];
          if (meta) {
            segments.push({
              key: meta.key,
              baseKey: meta.baseKey,
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
    const meta = entries[opened.id];
    if (meta) {
      segments.push({
        key: meta.key,
        baseKey: meta.baseKey,
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

export const isCopyEditorTrackingActive = (): boolean => trackingActive;

export const setCopyEditorTrackingActive = (active: boolean): void => {
  trackingActive = active;
};

/**
 * Runs a synchronous callback without attaching copy-editor markers to any
 * translations resolved inside it (used by the copy editor's own UI and
 * non-DOM consumers such as document.title).
 */
export const withoutCopyEditorMarkers = <T>(fn: () => T): T => {
  suppressDepth += 1;
  try {
    return fn();
  } finally {
    suppressDepth -= 1;
  }
};

export const COPY_EDITOR_POST_PROCESSOR_NAME = 'flowayCopyEditor';

interface ResolvedInfo {
  exactUsedKey?: string;
  usedKey?: string;
}

export const copyEditorPostProcessor: PostProcessorModule = {
  type: 'postProcessor',
  name: COPY_EDITOR_POST_PROCESSOR_NAME,
  process(value, key, options) {
    if (!trackingActive || suppressDepth > 0) return value;
    if (typeof value !== 'string' || value.length === 0) return value;
    const opt = options as { i18nResolved?: ResolvedInfo; copyEditorSkip?: boolean } | undefined;
    if (opt?.copyEditorSkip) return value;
    const baseKey = opt?.i18nResolved?.usedKey ?? (Array.isArray(key) ? key[0] : key);
    const exactKey = opt?.i18nResolved?.exactUsedKey ?? baseKey;
    if (!exactKey || !baseKey) return value;
    return wrapWithKeyMarkers(value, exactKey, baseKey);
  },
};
