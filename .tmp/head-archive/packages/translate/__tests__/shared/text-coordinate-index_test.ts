import { expect, test } from 'vitest';

import { TextCoordinateIndex } from '../../src/shared/text-coordinate-index.ts';

test('maps code-point ranges to UTF-16 and follows later appends', () => {
  const index = TextCoordinateIndex.codePointsToUTF16('A\ud83d');
  index.append('\ude00中B');
  index.assertUTF16Length('A😀中B'.length);
  expect(index.codePointRangeToIR(1, 3)).toEqual({ start: 1, end_exclusive: 4 });
  expect(() => index.codePointRangeToIR(0, 5)).toThrow('exceeds text');
});

test('maps UTF-16 ranges to code points and rejects surrogate interiors', () => {
  const index = TextCoordinateIndex.utf16ToCodePoints('A\ud83d');
  index.append('\ude00中B');
  expect(index.irRangeToCodePoints({ start: 1, end_exclusive: 4 })).toEqual({ start: 1, end: 3 });
  expect(() => index.irRangeToCodePoints({ start: 2, end_exclusive: 4 })).toThrow('splits a surrogate pair');
});

test('maps UTF-16 ranges to UTF-8 bytes and requires well-formed text', () => {
  const index = TextCoordinateIndex.utf16ToUTF8('A\ud83d');
  expect(() => index.irRangeToUTF8({ start: 0, end_exclusive: 2 })).toThrow('well-formed Unicode');
  index.append('\ude00中B');
  expect(index.irRangeToUTF8({ start: 1, end_exclusive: 4 })).toEqual({ start: 1, end: 8 });
});

test('detects a missed append at the protocol owner', () => {
  const index = TextCoordinateIndex.codePointsToUTF16('text');
  expect(() => index.assertUTF16Length(5)).toThrow('covers 4 UTF-16 units, not 5');
});
