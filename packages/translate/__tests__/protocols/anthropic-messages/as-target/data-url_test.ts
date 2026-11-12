import { test } from 'vitest';

import { parseDataURL } from '../../../../src/protocols/anthropic-messages/as-target/data-url.ts';
import { assertEquals } from '@floway-dev/test-utils';

test('data URL parsing retains media-type parameters', () => {
  assertEquals(parseDataURL('data:text/csv;charset=utf-8;base64,YQ=='), {
    media_type: 'text/csv;charset=utf-8', data: 'YQ==',
  });
  assertEquals(parseDataURL('data:;base64,AAAA'), { data: 'AAAA' });
  assertEquals(parseDataURL('data:;charset=utf-8,hi'), {
    media_type: 'text/plain;charset=utf-8', data: 'aGk=',
  });
});

test('data URL parsing decodes percent-escaped bytes', () => {
  assertEquals(parseDataURL('data:image/svg+xml,%3Csvg%2F%3E'), {
    media_type: 'image/svg+xml', data: 'PHN2Zy8+',
  });
  assertEquals(parseDataURL('data:text/plain;charset=iso-8859-1,%E9'), {
    media_type: 'text/plain;charset=iso-8859-1', data: '6Q==',
  });
  assertEquals(parseDataURL('data:text/plain;base64,SGk%3D'), {
    media_type: 'text/plain', data: 'SGk=',
  });
});
