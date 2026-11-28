import { expect, test } from 'vitest';

import { TextCoordinateIndex } from '../../src/shared/text-coordinate-index.ts';

test('maps code-point ranges to UTF-16 and follows later appends', () => {
  const index = TextCoordinateIndex.codePointsToUTF16('A\ud83d');
  index.append('\ude00中B');
  index.assertUTF16Length('A😀中B'.length);
  expect(index.codePointRangeToUTF16(1, 3)).toEqual({ start: 1, end_exclusive: 4 });
  expect(() => index.codePointRangeToUTF16(0, 5)).toThrow();
});

test('maps UTF-16 ranges to code points and rejects surrogate interiors', () => {
  const index = TextCoordinateIndex.utf16ToCodePoints('A\ud83d');
  index.append('\ude00中B');
  expect(index.utf16RangeToCodePoints({ start: 1, end_exclusive: 4 })).toEqual({ start: 1, end: 3 });
  expect(() => index.utf16RangeToCodePoints({ start: 2, end_exclusive: 4 })).toThrow();
});

test('maps UTF-16 ranges to UTF-8 bytes and requires well-formed text', () => {
  const index = TextCoordinateIndex.utf16ToUTF8('A\ud83d');
  expect(() => index.utf16RangeToUTF8({ start: 0, end_exclusive: 2 })).toThrow();
  index.append('\ude00中B');
  expect(index.utf16RangeToUTF8({ start: 1, end_exclusive: 4 })).toEqual({ start: 1, end: 8 });
});

test('maps UTF-8 byte ranges to UTF-16 across surrogate appends and rejects mid-character boundaries', () => {
  const index = TextCoordinateIndex.utf8ToUTF16('A\ud83d');
  expect(() => index.utf8RangeToUTF16(0, 1)).toThrow();
  index.append('\ude00中B');
  index.assertUTF16Length('A😀中B'.length);
  expect(index.utf8Length).toBe(9);
  expect(index.utf8RangeToUTF16(1, 8)).toEqual({ start: 1, end_exclusive: 4 });
  expect(() => index.utf8RangeToUTF16(2, 8)).toThrow();
  expect(() => index.utf8RangeToUTF16(1, 10)).toThrow();
});
