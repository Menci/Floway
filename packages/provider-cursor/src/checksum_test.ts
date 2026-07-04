import { describe, expect, test } from 'vitest';

import { generateCursorChecksum, bytesToBase64Url } from './checksum.ts';
import { sha256Hex } from '@floway-dev/platform';

describe('bytesToBase64Url', () => {
  test('encodes a single zero byte without padding', () => {
    expect(bytesToBase64Url(new Uint8Array([0]))).toBe('AA');
  });
  test('is url-safe (0xff -> _w, not /w)', () => {
    expect(bytesToBase64Url(new Uint8Array([0xff]))).toBe('_w');
  });
});

describe('generateCursorChecksum', () => {
  test('has the <base64url><hex1>/<hex2> shape', async () => {
    const cs = await generateCursorChecksum('a.b.c');
    expect(cs).toMatch(/^[A-Za-z0-9_-]+[0-9a-f]{8}\/[0-9a-f]{8}$/);
  });

  test('deterministic for the same token within a window', async () => {
    const a = await generateCursorChecksum('token.x.y');
    const b = await generateCursorChecksum('token.x.y');
    expect(a).toBe(b);
  });

  test('differs for different tokens', async () => {
    const a = await generateCursorChecksum('token.one');
    const b = await generateCursorChecksum('token.two');
    expect(a).not.toBe(b);
  });

  test('hex2 matches sha256(token).slice(0,8)', async () => {
    const token = 'header.payload.sig';
    const cs = await generateCursorChecksum(token);
    const hex2 = cs.split('/')[1]!;
    const expected = (await sha256Hex(new TextEncoder().encode(token))).slice(0, 8);
    expect(hex2).toBe(expected);
  });

  test('hex1 matches sha256(salt[1]).slice(0,8)', async () => {
    const token = 'header.saltbody.sig';
    const cs = await generateCursorChecksum(token);
    const tail = cs.split('/')[0]!;
    const hex1 = tail.slice(-8);
    const expected = (await sha256Hex(new TextEncoder().encode('saltbody'))).slice(0, 8);
    expect(hex1).toBe(expected);
  });
});
