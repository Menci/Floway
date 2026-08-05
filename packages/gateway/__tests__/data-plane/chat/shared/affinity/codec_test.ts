import { describe, expect, test, vi } from 'vitest';

import { AffinityCodec } from '../../../../../src/data-plane/chat/shared/affinity/index.ts';
import type { AffinityTarget } from '../../../../../src/data-plane/chat/shared/affinity/index.ts';
import { MAX_OPAQUE_TRAILER_BYTES } from '@floway-dev/protocols/common';

const SECRET = '00'.repeat(32);
const OTHER_SECRET = '11'.repeat(32);
const DOMAIN = 'test.carrier';
const affinity: AffinityTarget = {
  upstreamId: 'upstream-a',
  modelId: 'model-a',
};
const codec = new AffinityCodec(SECRET);
const otherCodec = new AffinityCodec(OTHER_SECRET);
const textEncoder = new TextEncoder();
const encrypt = crypto.subtle.encrypt.bind(crypto.subtle);

const wrapWithAuthenticatedPlaintext = async (
  plaintext: Uint8Array,
  original?: string,
): Promise<string> => {
  const encryptSpy = vi.spyOn(crypto.subtle, 'encrypt').mockImplementationOnce(
    async (algorithm, key) => await encrypt(algorithm, key, new Uint8Array(plaintext).buffer),
  );
  try {
    return await codec.wrap(original, affinity, DOMAIN);
  } finally {
    encryptSpy.mockRestore();
  }
};

// Carriers this codec issued for SECRET and DOMAIN. They are frozen wire
// contracts, not fixtures: carriers already held by clients are decrypted by
// whatever ships next, so the HKDF salt and info, the AAD layout, the
// plaintext property names, and the trailer framing all have to survive.
// Changing any of them fails here, and re-recording a literal is the same
// act as invalidating every conversation in flight.
const FROZEN_NATURAL_CARRIER = 'AQIDBAWDP9gwaNMPLCk0oQ+usEVivj9ZICVyL3fu4x8gkOodb/vEU6189ANDLBtP1EXGNZgndPVyP96bDlZSoRj0YjhY8AoD+3/H71+8hcKBW/GSaV0w7FiF2KM8wk70DuHUIi3AW6CvFXHjzpj0+kpy5J1oYWqpTuzqLLydXk0QCTDAvV7rEGaeayaWFfS1mp3j6ScS51X0wCa9niXtm/iMSQCe';
const FROZEN_SYNTHETIC_ITEM_CARRIER = 'DkCdKsZdZ+v/8P4ChjnTjAFw2mav5Gb8jlr+byGq7XOnwIOMWD7gFJz/+9aopdkCtWG78NxplcsTxbI5KzWNObjQ27tMBWA5p4GpbV0sHn3n1qv/79HjVbZSy4I+USVCmDkOe8CgS6JvaQRgjWFPJfNMqSfiEpzyTwB5';

describe('AffinityCodec', () => {
  test('unwraps a frozen carrier', async () => {
    expect(await codec.unwrap(FROZEN_NATURAL_CARRIER, DOMAIN)).toEqual({
      kind: 'owned',
      value: 'AQIDBAU=',
      version: 1,
      origin: 'base64',
      affinity: {
        upstreamId: 'upstream-a',
        modelId: 'model-a',
        rules: { reasoning: { effort: 'high' } },
      },
    });
  });

  test('unwraps a frozen synthetic item carrier', async () => {
    expect(await codec.unwrap(FROZEN_SYNTHETIC_ITEM_CARRIER, DOMAIN)).toEqual({
      kind: 'owned',
      version: 1,
      syntheticItem: true,
      affinity,
    });
  });

  test.each([
    ['raw', 'not base64!'],
    ['base64', btoa('upstream opaque bytes')],
    ['base64url', '--__'],
    ['empty raw', ''],
  ])('round-trips %s input', async (_label, original) => {
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
    const wrapped = await codec.wrap(undefined, affinity, DOMAIN);

    expect(await codec.unwrap(wrapped, DOMAIN)).toEqual({
      kind: 'owned',
      version: 1,
      affinity,
    });
  });

  test('marks a fully synthetic item independently from an originless slot', async () => {
    const wrapped = await codec.wrap(undefined, affinity, DOMAIN, { syntheticItem: true });

    expect(await codec.unwrap(wrapped, DOMAIN)).toEqual({
      kind: 'owned',
      version: 1,
      syntheticItem: true,
      affinity,
    });
    await expect(codec.wrap('upstream', affinity, DOMAIN, { syntheticItem: true })).rejects.toThrow(TypeError);
  });

  test('rejects affinity metadata outside the declared target shape', async () => {
    const wrapped = await codec.wrap(
      undefined,
      { ...affinity, extra: 'not-part-of-the-contract' } as AffinityTarget,
      DOMAIN,
    );

    expect(await codec.unwrap(wrapped, DOMAIN)).toEqual({ kind: 'foreign', value: wrapped });
  });

  test('does not base64-encode canonical base64 bytes a second time', async () => {
    const originalBytes = crypto.getRandomValues(new Uint8Array(48));
    const original = btoa(String.fromCharCode(...originalBytes));
    const wrapped = await codec.wrap(original, affinity, DOMAIN);
    const framedBytes = Uint8Array.from(atob(wrapped), char => char.charCodeAt(0));

    expect(framedBytes.subarray(0, originalBytes.length)).toEqual(originalBytes);
  });

  test('round-trips mixed raw UTF-16 code units exactly', async () => {
    const original = `a\ud800${String.fromCodePoint(0x1f600)}\udfffz`;
    const wrapped = await codec.wrap(original, affinity, DOMAIN);
    expect(await codec.unwrap(wrapped, DOMAIN)).toMatchObject({ kind: 'owned', value: original });
  });

  test('preserves a foreign value byte-for-byte on authentication failure', async () => {
    const wrapped = await codec.wrap('opaque', affinity, DOMAIN);

    expect(await otherCodec.unwrap(wrapped, DOMAIN)).toEqual({ kind: 'foreign', value: wrapped });
  });

  test('preserves malformed and tampered values as foreign', async () => {
    const wrapped = await codec.wrap('opaque', affinity, DOMAIN);
    const bytes = Uint8Array.from(atob(wrapped), char => char.charCodeAt(0));
    bytes[bytes.length - 3] ^= 1;
    const tampered = btoa(String.fromCharCode(...bytes));

    expect(await codec.unwrap('not-a-carrier', DOMAIN)).toEqual({ kind: 'foreign', value: 'not-a-carrier' });
    expect(await codec.unwrap(tampered, DOMAIN)).toEqual({ kind: 'foreign', value: tampered });
  });

  test('unwraps nested gateway carriers one layer at a time', async () => {
    const inner = await otherCodec.wrap('upstream', affinity, DOMAIN);
    const outer = await codec.wrap(inner, { ...affinity, upstreamId: 'inner-gateway' }, DOMAIN);

    const outerDecoded = await codec.unwrap(outer, DOMAIN);
    expect(outerDecoded.kind).toBe('owned');
    if (outerDecoded.kind !== 'owned') throw new Error('Expected owned outer carrier');
    expect(outerDecoded.value).toBe(inner);
    expect(await otherCodec.unwrap(outerDecoded.value!, DOMAIN)).toMatchObject({ kind: 'owned', value: 'upstream' });
  });

  test('authenticates the carrier domain and original bytes', async () => {
    const wrapped = await codec.wrap('opaque', affinity, DOMAIN);
    expect(await codec.unwrap(wrapped, 'other.carrier')).toEqual({ kind: 'foreign', value: wrapped });

    const bytes = Uint8Array.from(atob(wrapped), char => char.charCodeAt(0));
    bytes[0] ^= 1;
    const transplanted = btoa(String.fromCharCode(...bytes));
    expect(await codec.unwrap(transplanted, DOMAIN)).toEqual({ kind: 'foreign', value: transplanted });
  });

  test.each([
    ['invalid UTF-8', Uint8Array.of(0xff), undefined],
    [
      'an origin on a synthetic item',
      textEncoder.encode(JSON.stringify({ version: 1, origin: 'raw', syntheticItem: true, affinity })),
      undefined,
    ],
    [
      'originless metadata attached to original bytes',
      textEncoder.encode(JSON.stringify({ version: 1, affinity })),
      'opaque',
    ],
    [
      'raw origin with an odd original byte length',
      textEncoder.encode(JSON.stringify({ version: 1, origin: 'raw', affinity })),
      'YQ==',
    ],
  ] as const)('preserves authenticated malformed plaintext as foreign: %s', async (_label, plaintext, original) => {
    const wrapped = await wrapWithAuthenticatedPlaintext(plaintext, original);
    expect(await codec.unwrap(wrapped, DOMAIN)).toEqual({ kind: 'foreign', value: wrapped });
  });

  test('accepts the largest carrier domain marker and rejects the next byte', async () => {
    await expect(codec.wrap(undefined, affinity, 'a'.repeat(MAX_OPAQUE_TRAILER_BYTES))).resolves.toEqual(expect.any(String));
    await expect(codec.wrap(undefined, affinity, 'a'.repeat(MAX_OPAQUE_TRAILER_BYTES + 1))).rejects.toThrow(RangeError);
  });

  test('rejects affinity metadata too large for the encrypted trailer marker', async () => {
    const oversized = {
      ...affinity,
      rules: { metadata: 'x'.repeat(MAX_OPAQUE_TRAILER_BYTES) },
    } as unknown as AffinityTarget;
    await expect(codec.wrap(undefined, oversized, DOMAIN)).rejects.toThrow(RangeError);
  });

  test('rejects malformed secrets', () => {
    expect(() => new AffinityCodec('00')).toThrow(TypeError);
    expect(() => new AffinityCodec('AA'.repeat(32))).toThrow(TypeError);
  });
});
