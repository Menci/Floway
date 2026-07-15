import { describe, expect, test } from 'vitest';

import { AffinityCodec } from './codec.ts';
import type { AffinityTarget } from './types.ts';

const SECRET = '00'.repeat(32);
const OTHER_SECRET = '11'.repeat(32);
const affinity: AffinityTarget = {
  mode: 'prefer',
  upstreamId: 'upstream-a',
  upstreamRevision: '2026-07-15T00:00:00.000Z',
  modelId: 'model-a',
  rulesPresent: false,
};

describe('AffinityCodec', () => {
  test.each([
    ['raw', 'not base64!'],
    ['base64', btoa('upstream opaque bytes')],
    ['base64url', '--__'],
    ['empty raw', ''],
  ])('round-trips %s input', async (_label, original) => {
    const codec = new AffinityCodec(SECRET);
    const wrapped = await codec.wrap(original, affinity);
    const decoded = await codec.unwrap(wrapped);

    expect(decoded).toEqual({
      kind: 'owned',
      value: original,
      envelope: {
        version: 1,
        origin: _label === 'base64' ? 'base64' : _label === 'base64url' ? 'base64url' : 'raw',
        affinity,
      },
    });
  });

  test('uses no origin for a synthetic carrier', async () => {
    const codec = new AffinityCodec(SECRET);
    const wrapped = await codec.wrap(undefined, affinity);

    expect(await codec.unwrap(wrapped)).toEqual({
      kind: 'owned',
      envelope: { version: 1, affinity },
    });
  });

  test('does not base64-encode canonical base64 bytes a second time', async () => {
    const codec = new AffinityCodec(SECRET);
    const originalBytes = crypto.getRandomValues(new Uint8Array(48));
    const original = btoa(String.fromCharCode(...originalBytes));
    const wrapped = await codec.wrap(original, affinity);
    const framedBytes = Uint8Array.from(atob(wrapped), char => char.charCodeAt(0));

    expect(framedBytes.subarray(0, originalBytes.length)).toEqual(originalBytes);
  });

  test('preserves a foreign value byte-for-byte on authentication failure', async () => {
    const wrapped = await new AffinityCodec(SECRET).wrap('opaque', affinity);

    expect(await new AffinityCodec(OTHER_SECRET).unwrap(wrapped)).toEqual({ kind: 'foreign', value: wrapped });
  });

  test('preserves malformed and tampered values as foreign', async () => {
    const codec = new AffinityCodec(SECRET);
    const wrapped = await codec.wrap('opaque', affinity);
    const bytes = Uint8Array.from(atob(wrapped), char => char.charCodeAt(0));
    bytes[bytes.length - 3] ^= 1;
    const tampered = btoa(String.fromCharCode(...bytes));

    expect(await codec.unwrap('not-an-envelope')).toEqual({ kind: 'foreign', value: 'not-an-envelope' });
    expect(await codec.unwrap(tampered)).toEqual({ kind: 'foreign', value: tampered });
  });

  test('unwraps nested gateway carriers one layer at a time', async () => {
    const innerCodec = new AffinityCodec(OTHER_SECRET);
    const outerCodec = new AffinityCodec(SECRET);
    const inner = await innerCodec.wrap('upstream', affinity);
    const outer = await outerCodec.wrap(inner, { ...affinity, upstreamId: 'inner-gateway' });

    const outerDecoded = await outerCodec.unwrap(outer);
    expect(outerDecoded.kind).toBe('owned');
    if (outerDecoded.kind !== 'owned') throw new Error('Expected owned outer carrier');
    expect(outerDecoded.value).toBe(inner);
    expect(await innerCodec.unwrap(outerDecoded.value!)).toMatchObject({ kind: 'owned', value: 'upstream' });
  });

  test('rejects malformed secrets', () => {
    expect(() => new AffinityCodec('00')).toThrow(TypeError);
    expect(() => new AffinityCodec('AA'.repeat(32))).toThrow(TypeError);
  });
});
