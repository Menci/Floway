import { test } from 'vitest';

import { mediaFromURL, parseDataURL } from '../../../src/ir/input/media.ts';
import { assertEquals } from '@floway-dev/test-utils';

test.each([
  'https://example.com/a.png',
  'data:image/png;charset=utf-8;base64,AAAA',
  'data:image/svg+xml,%3Csvg%2F%3E',
])('a URL remains exactly the source value %s', url => {
  assertEquals(mediaFromURL(url), { source_kind: 'url', url });
});

test('target-boundary data URL parsing retains media-type parameters', () => {
  assertEquals(parseDataURL('data:text/csv;charset=utf-8;base64,YQ=='), {
    media_type: 'text/csv;charset=utf-8', data: 'YQ==',
  });
  assertEquals(parseDataURL('data:;base64,AAAA'), { data: 'AAAA' });
});

test('target-boundary data URL parsing encodes percent-escaped bytes', () => {
  assertEquals(parseDataURL('data:image/svg+xml,%3Csvg%2F%3E'), {
    media_type: 'image/svg+xml', data: 'PHN2Zy8+',
  });
  assertEquals(parseDataURL('data:text/plain;charset=iso-8859-1,%E9'), {
    media_type: 'text/plain;charset=iso-8859-1', data: '6Q==',
  });
});
