import { describe, expect, test } from 'vitest';

import { unwrapCopilotItemId, wrapCopilotItemId } from './item-id-carrier.ts';

describe('Copilot item id carrier', () => {
  test.each([
    ['raw', 'not base64!'],
    ['base64', btoa('upstream opaque bytes')],
    ['base64url', '--__'],
    ['empty raw', ''],
  ])('round-trips %s blobs and their upstream ids', (_label, original) => {
    const wrapped = wrapCopilotItemId(original, 'rs_upstream');

    expect(unwrapCopilotItemId(wrapped)).toEqual({
      kind: 'owned',
      value: original,
      version: 1,
      origin: _label === 'base64' ? 'base64' : _label === 'base64url' ? 'base64url' : 'raw',
      id: 'rs_upstream',
    });
  });

  test.each(['\ud800', '\udfff', `a\ud800${String.fromCodePoint(0x1f600)}\udfffz`])(
    'round-trips raw UTF-16 code units exactly',
    original => {
      expect(unwrapCopilotItemId(wrapCopilotItemId(original, 'rs_raw'))).toMatchObject({
        kind: 'owned',
        value: original,
      });
    },
  );

  test('unwraps one independently appended layer at a time', () => {
    const inner = wrapCopilotItemId('opaque', 'rs_inner');
    const outer = wrapCopilotItemId(inner, 'rs_outer');

    expect(unwrapCopilotItemId(outer)).toMatchObject({ kind: 'owned', value: inner, id: 'rs_outer' });
    expect(unwrapCopilotItemId(inner)).toMatchObject({ kind: 'owned', value: 'opaque', id: 'rs_inner' });
  });

  test('leaves malformed and non-carrier values byte-for-byte unchanged', () => {
    const wrapped = wrapCopilotItemId('opaque', 'rs_upstream');
    const bytes = Uint8Array.from(atob(wrapped), char => char.charCodeAt(0));
    bytes[bytes.length - 1] ^= 1;
    const malformed = btoa(String.fromCharCode(...bytes));

    expect(unwrapCopilotItemId('not-a-carrier')).toEqual({ kind: 'foreign', value: 'not-a-carrier' });
    expect(unwrapCopilotItemId(malformed)).toEqual({ kind: 'foreign', value: malformed });
  });

  test('does not double-encode canonical base64 bytes', () => {
    const originalBytes = crypto.getRandomValues(new Uint8Array(48));
    const original = btoa(String.fromCharCode(...originalBytes));
    const wrapped = wrapCopilotItemId(original, 'rs_upstream');
    const framedBytes = Uint8Array.from(atob(wrapped), char => char.charCodeAt(0));

    expect(framedBytes.subarray(0, originalBytes.length)).toEqual(originalBytes);
  });
});
