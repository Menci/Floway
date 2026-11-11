import { test } from 'vitest';

import { mediaFromURL } from '../../../src/ir/input/media.ts';
import { assertEquals } from '@floway-dev/test-utils';

test('a base64 data URL states its media type and body apart', () => {
  assertEquals(mediaFromURL('data:application/pdf;base64,JVBERi0='), {
    source_kind: 'base64', media_type: 'application/pdf', data: 'JVBERi0=',
  });
});

test('a media type carrying a parameter keeps only its essence', () => {
  // RFC 2397 lets the type carry parameters; the payload is what follows the
  // `;base64` marker, not the whole URL text.
  assertEquals(mediaFromURL('data:text/csv;charset=utf-8;base64,YQ=='), {
    source_kind: 'base64', media_type: 'text/csv', data: 'YQ==',
  });
  assertEquals(mediaFromURL('data:image/png;charset=utf-8;base64,AAAA'), {
    source_kind: 'base64', media_type: 'image/png', data: 'AAAA',
  });
});

test('a base64 data URL that states no media type still decodes', () => {
  assertEquals(mediaFromURL('data:;base64,AAAA'), { source_kind: 'base64', data: 'AAAA' });
});

test('a data URL this cannot decode is neither a URL nor raw base64', () => {
  // Reporting it as a URL would let a caller carry the URL text as the payload.
  assertEquals(mediaFromURL('data:text/plain,hi'), undefined);
});

test('a value that is not a data URL stays a URL', () => {
  assertEquals(mediaFromURL('https://example.com/a.png'), { source_kind: 'url', url: 'https://example.com/a.png' });
  assertEquals(mediaFromURL('AAAA'), { source_kind: 'url', url: 'AAAA' });
});
