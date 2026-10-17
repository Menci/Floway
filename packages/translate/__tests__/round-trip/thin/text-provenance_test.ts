import { expect, it } from 'vitest';

import { provenanceSpanForAppend, replayTextProvenance } from '../../../src/round-trip/thin/text-provenance.ts';

it('captures appended suffixes and replays literal gaps around provenance spans', () => {
  const spans = [
    provenanceSpanForAppend('prefix tracked', 'tracked', [3]),
    provenanceSpanForAppend('prefix tracked suffix', ' suffix'),
  ];
  const output: Array<{ text: string; partIds?: readonly number[] }> = [];
  replayTextProvenance('prefix tracked suffix', spans, (text, partIds) => {
    output.push({ text, ...(partIds === undefined ? {} : { partIds }) });
  });
  expect(output).toEqual([
    { text: 'prefix ' },
    { text: 'tracked', partIds: [3] },
    { text: ' suffix' },
  ]);
});

it('rejects mismatched appends and invalid span sequences', () => {
  expect(() => provenanceSpanForAppend('complete', 'other')).toThrowError('does not match accumulated text');
  expect(() => replayTextProvenance('text', [{ start: 0, endExclusive: 5 }], () => {})).toThrowError('ordered, disjoint, and in bounds');
  expect(() => replayTextProvenance('text', [
    { start: 1, endExclusive: 3 },
    { start: 2, endExclusive: 4 },
  ], () => {})).toThrowError('ordered, disjoint, and in bounds');
});

it('preserves literal gaps between and after tracked spans', () => {
  const output: Array<{ text: string; partIds?: readonly number[] }> = [];
  replayTextProvenance('aXXbYYc', [
    { start: 1, endExclusive: 3, partIds: [1] },
    { start: 4, endExclusive: 6, partIds: [2] },
  ], (text, partIds) => output.push({ text, ...(partIds === undefined ? {} : { partIds }) }));

  expect(output).toEqual([
    { text: 'a' },
    { text: 'XX', partIds: [1] },
    { text: 'b' },
    { text: 'YY', partIds: [2] },
    { text: 'c' },
  ]);
});
