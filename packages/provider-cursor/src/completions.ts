// Cursor Tab (StreamCpp) → OpenAI /v1/completions bridge helpers.
//
// FIM / plain-prompt path: an incoming `/v1/completions` prompt is split into
// prefix/suffix (FIM tokens or plain), turned into a StreamCpp request
// (contents = prefix+suffix, cursor at the prefix/suffix boundary), and the
// model's rewritten region is reduced back to the pure insertion the FIM
// client expects. Zeta marker formats (V0318/V0615) live in zeta-format.ts.

import { TEXT_ENCODER } from './proto/encoding.ts';
import type { StreamCppLineRange, StreamCppRequestInput } from './proto/stream-cpp.ts';

export interface PrefixSuffix {
  prefix: string;
  suffix: string;
}

// Fill-in-the-middle token triples (prefix / suffix / middle), matching the
// formats Zed's fim.rs and other clients emit. Delimiter whitespace (e.g.
// CodeLlama's spaces) is baked into the markers so the extracted prefix/suffix
// stay byte-exact — trimming would corrupt cursor-adjacent whitespace. Order
// matters: more specific (multi-char) markers are tried first.
const FIM_TRIPLES: readonly { pre: string; suf: string; mid: string }[] = [
  { pre: '<｜fim▁begin｜>', suf: '<｜fim▁hole｜>', mid: '<｜fim▁end｜>' }, // DeepSeek
  { pre: '<|fim_prefix|>', suf: '<|fim_suffix|>', mid: '<|fim_middle|>' }, // Qwen / CodeGemma
  { pre: '<|code_prefix|>', suf: '<|code_suffix|>', mid: '<|code_middle|>' }, // GLM
  { pre: '<fim_prefix>', suf: '<fim_suffix>', mid: '<fim_middle>' }, // StarCoder
  { pre: '<PRE> ', suf: ' <SUF>', mid: ' <MID>' }, // CodeLlama (spaces are delimiters)
];

// Parse a completions `prompt` into prefix/suffix. Handles the FIM token
// triples above, Codestral's reversed [SUFFIX]…[PREFIX]…, and an explicit
// OpenAI `suffix` field; falls back to treating the whole prompt as the prefix.
export const parsePrefixSuffix = (prompt: string, explicitSuffix?: string): PrefixSuffix => {
  if (explicitSuffix !== undefined) return { prefix: prompt, suffix: explicitSuffix };

  for (const { pre, suf, mid } of FIM_TRIPLES) {
    const pi = prompt.indexOf(pre);
    const si = prompt.indexOf(suf);
    const mi = prompt.indexOf(mid);
    if (pi !== -1 && si > pi && mi > si) {
      return { prefix: prompt.slice(pi + pre.length, si), suffix: prompt.slice(si + suf.length, mi) };
    }
  }

  // Codestral: [SUFFIX]{suffix}[PREFIX]{prefix}
  const csSuf = prompt.indexOf('[SUFFIX]');
  const csPre = prompt.indexOf('[PREFIX]');
  if (csSuf !== -1 && csPre > csSuf) {
    return { prefix: prompt.slice(csPre + '[PREFIX]'.length), suffix: prompt.slice(csSuf + '[SUFFIX]'.length, csPre) };
  }

  return { prefix: prompt, suffix: '' };
};

// Cursor position at the prefix/suffix boundary within contents = prefix+suffix.
export const cursorAtBoundary = (prefix: string): { line: number; column: number } => {
  const before = prefix.split('\n');
  return { line: before.length - 1, column: before[before.length - 1].length };
};

export const streamCppInputForPrefixSuffix = (ps: PrefixSuffix, opts: { relativePath: string; languageId: string; modelName: string }): StreamCppRequestInput => {
  const pos = cursorAtBoundary(ps.prefix);
  return {
    relativePath: opts.relativePath,
    contents: ps.prefix + ps.suffix,
    cursorLine: pos.line,
    cursorColumn: pos.column,
    languageId: opts.languageId,
    modelName: opts.modelName,
  };
};

// Apply StreamCpp's rewritten-region `text` to the original file (whole file
// when no range was emitted). The removed span is bounded by `range` — NOT by
// text's newline count — so an insertion (where `text` has more lines than the
// span) does not consume following lines. `endLine`'s inclusive/exclusive sense
// is inferred from `text`: a trailing newline means the edit ends at a line
// boundary (exclusive — stop at the start of line `endLine`), otherwise the
// last line is partial (inclusive — through line `endLine`'s content). Verified
// against live captures: {2,7}+trailing-\n replaced lines 2-6; {1,6} and a
// no-trailing-\n extractKey case were inclusive; an insertion sent {1,6} with a
// longer `text` and must preserve the line after the object.
export const applyRewrite = (contents: string, range: StreamCppLineRange | undefined, text: string): string => {
  if (!range) return text;
  const lines = contents.split('\n');
  const start = range.startLineNumber - 1;
  if (start < 0 || start > lines.length) return contents;
  let startOff = 0;
  for (let i = 0; i < start; i++) startOff += lines[i].length + 1;
  let endIdx = range.endLine - 1;
  if (endIdx < start) endIdx = start;
  let endOff = 0;
  for (let i = 0; i < endIdx && i < lines.length; i++) endOff += lines[i].length + 1;
  if (!text.endsWith('\n') && endIdx < lines.length) endOff += lines[endIdx].length;
  endOff = Math.min(Math.max(endOff, startOff), contents.length);
  return contents.slice(0, startOff) + text + contents.slice(endOff);
};

// Reduce the rewritten file to the pure insertion at the cursor: the text that
// sits between the original prefix and suffix. Returns '' when the model's edit
// isn't a clean cursor-anchored insertion (it rewrote prefix/suffix) — the FIM
// client then simply shows no suggestion. Tolerates a trailing-newline mismatch
// at EOF (Cursor's rewrite carries the final line's newline; the client's
// suffix may or may not).
export const extractInsertion = (ps: PrefixSuffix, range: StreamCppLineRange | undefined, text: string): string => {
  if (!text) return '';
  const rewritten = applyRewrite(ps.prefix + ps.suffix, range, text);
  if (!rewritten.startsWith(ps.prefix)) return '';
  let mid = rewritten.slice(ps.prefix.length);
  if (ps.suffix) {
    if (mid.endsWith(ps.suffix)) mid = mid.slice(0, mid.length - ps.suffix.length);
    else if (mid.endsWith(`${ps.suffix}\n`)) mid = mid.slice(0, mid.length - ps.suffix.length - 1);
    else if (ps.suffix.endsWith('\n') && mid.endsWith(ps.suffix.slice(0, -1))) mid = mid.slice(0, mid.length - ps.suffix.length + 1);
    else return '';
  }
  return mid;
};

// Truncate a completion at the first stop sequence (OpenAI `stop` semantics).
export const applyStops = (text: string, stop: string | readonly string[] | undefined): string => {
  if (!stop) return text;
  const stops = (Array.isArray(stop) ? stop : [stop]).filter((s): s is string => typeof s === 'string' && s.length > 0);
  let out = text;
  for (const s of stops) {
    const i = out.indexOf(s);
    if (i !== -1) out = out.slice(0, i);
  }
  return out;
};

// A minimal, well-formed OpenAI text_completion body for the passthrough serve.
// `usage` is required — callers pass estimated token counts so the shared
// passthrough usage recorder (data-plane/completions/usage.ts) has real numbers
// to store. Estimates come from `estimateCursorTabTokens` below.
export interface CompletionsUsage {
  promptTokens: number;
  completionTokens: number;
}

export const completionsResponseBody = (model: string, text: string, usage: CompletionsUsage): string =>
  JSON.stringify({
    id: `cmpl-cursor-${crypto.randomUUID()}`,
    object: 'text_completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ text, index: 0, finish_reason: 'stop', logprobs: null }],
    usage: {
      prompt_tokens: usage.promptTokens,
      completion_tokens: usage.completionTokens,
      total_tokens: usage.promptTokens + usage.completionTokens,
    },
  });

// Static per-request token estimator for Cursor Tab. StreamCpp returns no
// usage of its own, and Cursor's aiserver.v1.AiService/CountTokens takes
// ~1s per call — too slow to bolt onto autocomplete latency — and ignores
// its `model_name` field entirely (one fixed BPE tokenizer, probed
// 2026-07-03). Ratios below are calibrated against that endpoint on
// representative Lorem-ipsum prose and Python code samples.
//
// Cursor Tab is code-domain by design; the code ratio is the default. The
// prose ratio kicks in only when the client tags a plain-text file
// (`body.language = 'markdown' | 'txt' | ...`).
const CURSOR_TAB_BYTES_PER_TOKEN_CODE = 2.55;
const CURSOR_TAB_BYTES_PER_TOKEN_PROSE = 5.67;
const PROSE_LANGUAGES: ReadonlySet<string> = new Set(['markdown', 'md', 'mdx', 'rst', 'txt']);

export const estimateCursorTabTokens = (text: string, languageId: string): number => {
  if (!text) return 0;
  const bytes = TEXT_ENCODER.encode(text).length;
  const ratio = PROSE_LANGUAGES.has(languageId.toLowerCase())
    ? CURSOR_TAB_BYTES_PER_TOKEN_PROSE
    : CURSOR_TAB_BYTES_PER_TOKEN_CODE;
  return Math.max(1, Math.ceil(bytes / ratio));
};

export const languageIdForCompletion = (body: { language?: unknown }): string =>
  (typeof body.language === 'string' && body.language) || 'plaintext';
