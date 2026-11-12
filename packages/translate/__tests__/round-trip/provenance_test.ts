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
  expect(() => provenanceSpanForAppend('complete', 'other')).toThrowError('does not match accumulated text');
  expect(() => replayTextProvenance('text', [{ start: 0, endExclusive: 5 }], () => {})).toThrowError('ordered, disjoint, and in bounds');
  expect(() => replayTextProvenance('text', [
    { start: 1, endExclusive: 3 },
    { start: 2, endExclusive: 4 },
  ], () => {})).toThrowError('ordered, disjoint, and in bounds');
});

it('preserves literal gaps between and after tracked spans', () => {
  const output: Array<{ text: string; textFragmentIds?: readonly number[] }> = [];
  replayTextProvenance('aXXbYYc', [
    { start: 1, endExclusive: 3, textFragmentIds: [1] },
    { start: 4, endExclusive: 6, textFragmentIds: [2] },
  ], (text, textFragmentIds) => output.push({ text, ...(textFragmentIds === undefined ? {} : { textFragmentIds }) }));

  expect(output).toEqual([
    { text: 'a' },
    { text: 'XX', textFragmentIds: [1] },
    { text: 'b' },
    { text: 'YY', textFragmentIds: [2] },
    { text: 'c' },
  ]);
});
