import { describe, expect, test } from 'vitest';

import { AffinityCodec } from './index.ts';
import type { AffinityTarget } from './index.ts';

const SECRET = '00'.repeat(32);
const OTHER_SECRET = '11'.repeat(32);
const DOMAIN = 'test.carrier';
const affinity: AffinityTarget = {
  upstreamId: 'upstream-a',
  modelId: 'model-a',
};

describe('AffinityCodec', () => {
  test.each([
    ['raw', 'not base64!'],
    ['base64', btoa('upstream opaque bytes')],
    ['base64url', '--__'],
    ['empty raw', ''],
  ])('round-trips %s input', async (_label, original) => {
    const codec = new AffinityCodec(SECRET);
    const wrapped = await codec.wrap(original, affinity, DOMAIN);
    const decoded = await codec.unwrap(wrapped, DOMAIN);

    expect(decoded).toEqual({
      kind: 'owned',
      value: original,
      version: 1,
      origin: _label === 'base64' ? 'base64' : _label === 'base64url' ? 'base64url' : 'raw',
      affinity,
    });
  });

  test('uses no origin for a synthetic carrier', async () => {
    const codec = new AffinityCodec(SECRET);
    const wrapped = await codec.wrap(undefined, affinity, DOMAIN);

    expect(await codec.unwrap(wrapped, DOMAIN)).toEqual({
      kind: 'owned',
      version: 1,
      affinity,
    });
  });

  test('rejects affinity metadata outside the declared target shape', async () => {
    const codec = new AffinityCodec(SECRET);
    const wrapped = await codec.wrap(
      undefined,
      { ...affinity, extra: 'not-part-of-the-contract' } as AffinityTarget,
      DOMAIN,
    );

    expect(await codec.unwrap(wrapped, DOMAIN)).toEqual({ kind: 'foreign', value: wrapped });
  });

  test('does not base64-encode canonical base64 bytes a second time', async () => {
    const codec = new AffinityCodec(SECRET);
    const originalBytes = crypto.getRandomValues(new Uint8Array(48));
    const original = btoa(String.fromCharCode(...originalBytes));
    const wrapped = await codec.wrap(original, affinity, DOMAIN);
    const framedBytes = Uint8Array.from(atob(wrapped), char => char.charCodeAt(0));

    expect(framedBytes.subarray(0, originalBytes.length)).toEqual(originalBytes);
  });

  test.each(['\ud800', '\udfff', `a\ud800${String.fromCodePoint(0x1f600)}\udfffz`])(
    'round-trips raw UTF-16 code units exactly',
    async original => {
      const codec = new AffinityCodec(SECRET);
      const wrapped = await codec.wrap(original, affinity, DOMAIN);
      expect(await codec.unwrap(wrapped, DOMAIN)).toMatchObject({ kind: 'owned', value: original });
    },
  );

  test('preserves a foreign value byte-for-byte on authentication failure', async () => {
    const wrapped = await new AffinityCodec(SECRET).wrap('opaque', affinity, DOMAIN);

    expect(await new AffinityCodec(OTHER_SECRET).unwrap(wrapped, DOMAIN)).toEqual({ kind: 'foreign', value: wrapped });
  });

  test('preserves malformed and tampered values as foreign', async () => {
    const codec = new AffinityCodec(SECRET);
    const wrapped = await codec.wrap('opaque', affinity, DOMAIN);
    const bytes = Uint8Array.from(atob(wrapped), char => char.charCodeAt(0));
    bytes[bytes.length - 3] ^= 1;
    const tampered = btoa(String.fromCharCode(...bytes));

    expect(await codec.unwrap('not-a-carrier', DOMAIN)).toEqual({ kind: 'foreign', value: 'not-a-carrier' });
    expect(await codec.unwrap(tampered, DOMAIN)).toEqual({ kind: 'foreign', value: tampered });
  });

  test('unwraps nested gateway carriers one layer at a time', async () => {
    const innerCodec = new AffinityCodec(OTHER_SECRET);
    const outerCodec = new AffinityCodec(SECRET);
    const inner = await innerCodec.wrap('upstream', affinity, DOMAIN);
    const outer = await outerCodec.wrap(inner, { ...affinity, upstreamId: 'inner-gateway' }, DOMAIN);

    const outerDecoded = await outerCodec.unwrap(outer, DOMAIN);
    expect(outerDecoded.kind).toBe('owned');
    if (outerDecoded.kind !== 'owned') throw new Error('Expected owned outer carrier');
    expect(outerDecoded.value).toBe(inner);
    expect(await innerCodec.unwrap(outerDecoded.value!, DOMAIN)).toMatchObject({ kind: 'owned', value: 'upstream' });
  });

  test('authenticates the carrier domain and original bytes', async () => {
    const codec = new AffinityCodec(SECRET);
    const wrapped = await codec.wrap('opaque', affinity, DOMAIN);
    expect(await codec.unwrap(wrapped, 'other.carrier')).toEqual({ kind: 'foreign', value: wrapped });

    const bytes = Uint8Array.from(atob(wrapped), char => char.charCodeAt(0));
    bytes[0] ^= 1;
    const transplanted = btoa(String.fromCharCode(...bytes));
    expect(await codec.unwrap(transplanted, DOMAIN)).toEqual({ kind: 'foreign', value: transplanted });
  });

  test('rejects malformed secrets', () => {
    expect(() => new AffinityCodec('00')).toThrow(TypeError);
    expect(() => new AffinityCodec('AA'.repeat(32))).toThrow(TypeError);
  });
});
