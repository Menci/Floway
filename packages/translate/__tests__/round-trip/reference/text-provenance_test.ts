import { expect, it } from 'vitest';

import { provenanceSpanForAppend, replayTextProvenance } from '../../../src/round-trip/reference/text-provenance.ts';

it('captures appended suffixes and replays literal gaps around provenance spans', () => {
  const spans = [
    provenanceSpanForAppend('prefix tracked', 'tracked', [3]),
    provenanceSpanForAppend('prefix tracked suffix', ' suffix'),
  ];
  const output: Array<{ text: string; referencePieceIds?: readonly number[] }> = [];
  replayTextProvenance('prefix tracked suffix', spans, (text, referencePieceIds) => {
    output.push({ text, ...(referencePieceIds === undefined ? {} : { referencePieceIds }) });
  });
  expect(output).toEqual([
    { text: 'prefix ' },
    { text: 'tracked', referencePieceIds: [3] },
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
  const output: Array<{ text: string; referencePieceIds?: readonly number[] }> = [];
  replayTextProvenance('aXXbYYc', [
    { start: 1, endExclusive: 3, referencePieceIds: [1] },
    { start: 4, endExclusive: 6, referencePieceIds: [2] },
  ], (text, referencePieceIds) => output.push({ text, ...(referencePieceIds === undefined ? {} : { referencePieceIds }) }));

  expect(output).toEqual([
    { text: 'a' },
    { text: 'XX', referencePieceIds: [1] },
    { text: 'b' },
    { text: 'YY', referencePieceIds: [2] },
    { text: 'c' },
  ]);
});
