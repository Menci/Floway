import type { TextFragmentId } from './reference/reference-builder.ts';

export interface TextProvenanceSpan {
  readonly start: number;
  readonly endExclusive: number;
  readonly textFragmentIds?: readonly TextFragmentId[];
}

export const provenanceSpanForAppend = (
  fullText: string,
  appended: string,
  textFragmentIds?: readonly TextFragmentId[],
): TextProvenanceSpan => {
  const endExclusive = fullText.length;
  const start = endExclusive - appended.length;
  if (start < 0 || fullText.slice(start) !== appended) throw new Error('Provenance append does not match accumulated text');
  return { start, endExclusive, ...(textFragmentIds === undefined ? {} : { textFragmentIds }) };
};

export const replayTextProvenance = (
  finalText: string,
  spans: readonly TextProvenanceSpan[],
  append: (text: string, textFragmentIds?: readonly TextFragmentId[]) => void,
): void => {
  let offset = 0;
  for (const span of spans) {
    if (span.start < offset || span.endExclusive < span.start || span.endExclusive > finalText.length) {
      throw new RangeError('Text provenance spans must be ordered, disjoint, and in bounds');
    }
    if (span.start > offset) append(finalText.slice(offset, span.start));
    append(finalText.slice(span.start, span.endExclusive), span.textFragmentIds);
    offset = span.endExclusive;
  }
  if (offset < finalText.length) append(finalText.slice(offset));
};
