import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { test } from 'vitest';

import { appendOpaqueTrailer, decodeOpaqueValue, encodeOpaqueValue, splitOpaqueTrailer } from '../../src/common/opaque-value.ts';
import { assert, assertEquals, assertThrows } from '@floway-dev/test-utils';

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

test('raw opaque values preserve every UTF-16 code unit', () => {
  const littleEndian = Buffer.alloc(0x10000 * 2);
  for (let codeUnit = 0; codeUnit <= 0xffff; codeUnit += 1) {
    littleEndian.writeUInt16LE(codeUnit, codeUnit * 2);
  }
  const expected = littleEndian.toString('utf16le');
  assertEquals(encodeOpaqueValue(littleEndian.swap16(), 'raw'), expected);
});

test.each([0, 8190, 8191, 8192, 8193, 16383, 16384, 16385, 131073])(
  'raw opaque values preserve BOMs and surrogate code units after %i characters',
  prefixLength => {
    const markers = String.fromCharCode(0xfeff, 0xd83d, 0xde00, 0xd800, 0x0000, 0xdfff, 0xfeff);
    const expected = markers[0] + 'a'.repeat(prefixLength) + markers.slice(1);
    const bytes = Buffer.from(expected, 'utf16le').swap16();
    const backing = Buffer.concat([Buffer.from([0xff]), bytes, Buffer.from([0xff])]);
    assertEquals(encodeOpaqueValue(backing.subarray(1, -1), 'raw'), expected);
  },
);

test('raw opaque values preserve empty input and reject incomplete code units', () => {
  assertEquals(encodeOpaqueValue(new Uint8Array(), 'raw'), '');
  assertThrows(() => encodeOpaqueValue(new Uint8Array([0x00]), 'raw'), TypeError);
  assertThrows(() => encodeOpaqueValue(new Uint8Array([0x00, 0x61, 0x00]), 'raw'), TypeError);
});

test('retained raw opaque values use heap proportional to decoded text', () => {
  const output = execFileSync(process.execPath, [
    '--expose-gc',
    '--max-old-space-size=256',
    '--import', 'jiti/register',
    fileURLToPath(new URL('./fixtures/opaque-value-retained-heap.ts', import.meta.url)),
  ], {
    encoding: 'utf8',
    env: { ...process.env, NODE_OPTIONS: '', JITI_FS_CACHE: 'false' },
    timeout: 60_000,
  });
  const result = JSON.parse(output) as { count: number; codeUnits: number; retainedHeapBytes: number };
  assertEquals(result.count, 64);
  assertEquals(result.codeUnits, 64 * 6144);
  assert(Number.isFinite(result.retainedHeapBytes));
  assert(
    result.retainedHeapBytes < result.codeUnits * 8 + 1024 * 1024,
    `Retained ${result.retainedHeapBytes} heap bytes for ${result.codeUnits} code units`,
  );
}, 60_000);

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
