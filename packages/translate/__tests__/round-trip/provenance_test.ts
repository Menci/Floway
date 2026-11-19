import { expect, it } from 'vitest';

import { provenanceSpanForAppend, replayTextProvenance } from '../../src/round-trip/provenance.ts';

it('captures appended suffixes and replays literal gaps around provenance spans', () => {
  const spans = [
    provenanceSpanForAppend('prefix tracked', 'tracked', [3]),
    provenanceSpanForAppend('prefix tracked suffix', ' suffix'),
  ];
  const output: Array<{ text: string; textFragmentIds?: readonly number[] }> = [];
  replayTextProvenance('prefix tracked suffix', spans, (text, textFragmentIds) => {
    output.push({ text, ...(textFragmentIds === undefined ? {} : { textFragmentIds }) });
  });
  expect(output).toEqual([
    { text: 'prefix ' },
    { text: 'tracked', textFragmentIds: [3] },
    { text: ' suffix' },
  ]);
});

it('rejects mismatched appends and invalid span sequences', () => {
  expect(() => provenanceSpanForAppend('complete', 'other')).toThrowError();
  expect(() => replayTextProvenance('text', [{ start: 0, endExclusive: 5 }], () => {})).toThrowError(RangeError);
  expect(() => replayTextProvenance('text', [
    { start: 1, endExclusive: 3 },
    { start: 2, endExclusive: 4 },
  ], () => {})).toThrowError(RangeError);
});
