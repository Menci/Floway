import type { IRUTF16TextRange } from '../ir.ts';

// Native Responses probes with 😀 and 📖 select complete links by code-point offsets.
// https://github.com/Menci/Floway/pull/594#issuecomment-6097199680
// ChatCompletions uses the same interpretation provisionally: actual captures prove half-open
// character ranges; new-api slices runes, while Promptfoo uses UTF-16 with ASCII-only tests.
// https://github.com/achappey/aihappey-ai/blob/8d791a6dc9696ade9876cfcbd3bb16bd4f17d7a6/Core/AIHappey.Tests/Fixtures/chat-completions/raw/openai-web-search-chat-completions.jsonl
// https://github.com/QuantumNous/new-api/blob/1d4328e97417a043a161a0dd30a5b129be3ace49/relaykit/relayconvert/internal/oai_chat/citations.go#L56-L66
// https://github.com/promptfoo/promptfoo/blob/69e0c140de5e3d08c0def5ee028946a718d16a1a/src/providers/openai/chat.ts#L125-L134
export const codePointRangeToIR = (text: string, start: number, end: number): IRUTF16TextRange => {
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start) throw new RangeError('Invalid code-point range');
  let points = 0;
  let units = 0;
  let first: number | undefined;
  for (const point of text) {
    if (points === start) first = units;
    if (points === end) return { start: first!, end_exclusive: units };
    points++;
    units += point.length;
  }
  if (points === start) first = units;
  if (points !== end) throw new RangeError('Code-point range exceeds text');
  return { start: first!, end_exclusive: units };
};

export const irRangeToCodePoints = (text: string, range: IRUTF16TextRange): { start: number; end: number } => {
  let points = 0;
  let units = 0;
  let start: number | undefined;
  for (const point of text) {
    if (units === range.start) start = points;
    if (units === range.end_exclusive && start !== undefined) return { start, end: points };
    units += point.length;
    points++;
  }
  if (units === range.start) start = points;
  if (units !== range.end_exclusive || start === undefined) throw new RangeError('IR range is outside text or splits a surrogate pair');
  return { start, end: points };
};

// GenerateContent grounding segment offsets count UTF-8 bytes.
// https://ai.google.dev/api/generate-content#Segment
export const irRangeToUTF8 = (text: string, range: IRUTF16TextRange): { start: number; end: number } => {
  irRangeToCodePoints(text, range);
  if (!text.isWellFormed()) throw new TypeError('GenerateContent byte coordinates require well-formed Unicode');
  const encoder = new TextEncoder();
  return { start: encoder.encode(text.slice(0, range.start)).length, end: encoder.encode(text.slice(0, range.end_exclusive)).length };
};
