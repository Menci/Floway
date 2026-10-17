import type { PartId } from './reference-builder.ts';

export interface TextProvenanceSpan {
  readonly start: number;
  readonly endExclusive: number;
  readonly partIds?: readonly PartId[];
}

export const provenanceSpanForAppend = (
  fullText: string,
  appended: string,
  partIds?: readonly PartId[],
): TextProvenanceSpan => {
  const endExclusive = fullText.length;
  const start = endExclusive - appended.length;
  if (start < 0 || fullText.slice(start) !== appended) throw new Error('Provenance append does not match accumulated text');
  return { start, endExclusive, ...(partIds === undefined ? {} : { partIds }) };
};

export const replayTextProvenance = (
  finalText: string,
  spans: readonly TextProvenanceSpan[],
  append: (text: string, partIds?: readonly PartId[]) => void,
): void => {
  let offset = 0;
  for (const span of spans) {
    if (span.start < offset || span.endExclusive < span.start || span.endExclusive > finalText.length) {
      throw new RangeError('Text provenance spans must be ordered, disjoint, and in bounds');
    }
    if (span.start > offset) append(finalText.slice(offset, span.start));
    append(finalText.slice(span.start, span.endExclusive), span.partIds);
    offset = span.endExclusive;
  }
  if (offset < finalText.length) append(finalText.slice(offset));
};
