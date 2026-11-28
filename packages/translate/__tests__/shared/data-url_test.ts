import { expect, test } from 'vitest';

import { isDataURL, parseDataURL } from '../../src/shared/data-url.ts';
import { TranslateInputException } from '../../src/shared/input-error.ts';

test('decodes base64 and percent-encoded data URLs including case-insensitive schemes and empty media types', () => {
  expect(isDataURL('DATA:image/png;base64,aGVsbG8=')).toBe(true);
  expect(isDataURL('https://example.com/a.png')).toBe(false);
  expect(parseDataURL('DATA:image/png;base64,aGVsbG8=')).toEqual({
    media_type: 'image/png',
    data: 'aGVsbG8=',
  });
  expect(parseDataURL('data:image/png;base64,aGVsbG8%3D')).toEqual({
    media_type: 'image/png',
    data: 'aGVsbG8=',
  });
  expect(parseDataURL('data:;charset=utf-8,hello%20world')).toEqual({
    media_type: 'text/plain;charset=utf-8',
    data: btoa('hello world'),
  });
  expect(parseDataURL('data:,hi')).toEqual({
    data: btoa('hi'),
  });
  expect(() => parseDataURL('https://example.com/a.png')).toThrow(TranslateInputException);
});
