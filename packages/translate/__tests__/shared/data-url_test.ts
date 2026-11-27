import { expect, test } from 'vitest';

import { parseDataURL } from '../../src/shared/data-url.ts';
import { TranslateInputException } from '../../src/shared/input-error.ts';

test('decodes base64 and percent-encoded data URLs including empty media types', () => {
  expect(parseDataURL('data:image/png;base64,aGVsbG8=')).toEqual({
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
