import { test } from 'vitest';

import { appendOpaqueTrailer, decodeOpaqueValue, encodeOpaqueValue, MAX_OPAQUE_TRAILER_BYTES, splitOpaqueTrailer, uint16be } from '../../src/common/opaque-value.ts';
import { assertEquals, assertThrows } from '@floway-dev/test-utils';

test('opaque values preserve canonical Base64 alphabets byte-for-byte', () => {
  assertEquals(decodeOpaqueValue('AP+A'), { bytes: new Uint8Array([0x00, 0xff, 0x80]), origin: 'base64' });
  assertEquals(decodeOpaqueValue('AP-A'), { bytes: new Uint8Array([0x00, 0xff, 0x80]), origin: 'base64url' });
  assertEquals(encodeOpaqueValue(new Uint8Array([0x00, 0xff, 0x80]), 'base64'), 'AP+A');
  assertEquals(encodeOpaqueValue(new Uint8Array([0x00, 0xff, 0x80]), 'base64url'), 'AP-A');
});

test('non-canonical encodings remain raw opaque values', () => {
  for (const value of [' AP+A', 'AP-A=', 'AB==']) {
    assertEquals(decodeOpaqueValue(value).origin, 'raw');
  }
});

test('raw opaque values freeze UTF-16 code units including lone surrogates', () => {
  const raw = 'raw:\u0000\ud800';
  const decoded = decodeOpaqueValue(raw);
  assertEquals(decoded, {
    bytes: new Uint8Array([0x00, 0x72, 0x00, 0x61, 0x00, 0x77, 0x00, 0x3a, 0x00, 0x00, 0xd8, 0x00]),
    origin: 'raw',
  });
  assertEquals(encodeOpaqueValue(decoded.bytes, decoded.origin), raw);
});

test('opaque trailers freeze original-trailer-length framing and alphabet selection', () => {
  const base64 = appendOpaqueTrailer(
    { bytes: new Uint8Array([0x01, 0x02]), origin: 'base64' },
    new Uint8Array([0xaa, 0xbb, 0xcc]),
  );
  assertEquals(base64, 'AQKqu8wAAw==');
  assertEquals(splitOpaqueTrailer(base64), {
    original: new Uint8Array([0x01, 0x02]),
    trailer: new Uint8Array([0xaa, 0xbb, 0xcc]),
  });

  const base64url = appendOpaqueTrailer(
    { bytes: new Uint8Array([0xfb, 0xff]), origin: 'base64url' },
    new Uint8Array([0x01, 0x02, 0x03]),
  );
  assertEquals(base64url, '-_8BAgMAAw');
  assertEquals(splitOpaqueTrailer(base64url), {
    original: new Uint8Array([0xfb, 0xff]),
    trailer: new Uint8Array([0x01, 0x02, 0x03]),
  });
});

test('opaque trailer framing enforces every unsigned 16-bit boundary', () => {
  assertEquals(uint16be(0), new Uint8Array([0, 0]));
  assertEquals(uint16be(MAX_OPAQUE_TRAILER_BYTES), new Uint8Array([0xff, 0xff]));
  for (const value of [-1, 1.5, Number.NaN, MAX_OPAQUE_TRAILER_BYTES + 1]) {
    assertThrows(() => uint16be(value), RangeError, 'Unsigned 16-bit value');
  }

  const maximum = new Uint8Array(MAX_OPAQUE_TRAILER_BYTES);
  const framed = appendOpaqueTrailer(undefined, maximum);
  assertEquals(splitOpaqueTrailer(framed)?.trailer.length, MAX_OPAQUE_TRAILER_BYTES);
  assertThrows(() => appendOpaqueTrailer(undefined, new Uint8Array(MAX_OPAQUE_TRAILER_BYTES + 1)), RangeError, '2-byte length marker');

  for (const minimum of [-1, 0.5, Number.NaN, MAX_OPAQUE_TRAILER_BYTES + 1]) {
    assertThrows(() => splitOpaqueTrailer(framed, minimum), RangeError, 'Minimum opaque trailer length');
  }
});
