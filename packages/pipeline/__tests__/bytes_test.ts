import { Buffer } from 'node:buffer';

import { describe, expect, it } from 'vitest';

import { viewOf } from '../src/bytes-view.ts';
import { Bytes } from '../src/index.ts';

describe('bytes', () => {
  it('adopts a whole buffer and detaches the old view', () => {
    const owned = new Uint8Array([9, 8, 7]);
    const bytes = Bytes.adopt(owned);
    expect(owned.buffer.detached).toBe(true);
    expect(bytes.toUint8Array()).toEqual(new Uint8Array([9, 8, 7]));
  });

  it('copies a pooled Buffer, a sliced view, and shared storage', () => {
    const pool = Buffer.allocUnsafe(3).fill(1);
    expect(pool.buffer.byteLength).toBeGreaterThan(pool.byteLength);
    const sliced = new Uint8Array([1, 1, 1]).subarray(1);
    const shared = new Uint8Array(new SharedArrayBuffer(1)).fill(1);
    for (const input of [pool, sliced, shared]) {
      const length = input.byteLength;
      const bytes = Bytes.adopt(input);
      input.fill(2);
      expect(input.byteLength).toBe(length);
      expect(bytes.toUint8Array()).toEqual(new Uint8Array(length).fill(1));
    }
  });

  it('shares subarray storage and returns a fresh writable copy to the public caller', () => {
    const bytes = Bytes.concat([Bytes.fromUtf8('hola'), Bytes.empty, Bytes.fromUtf8(' mundo')]);
    const subarray = bytes.subarray(-5);
    expect(viewOf(subarray).buffer).toBe(viewOf(bytes).buffer);
    expect(subarray.equals(Bytes.fromUtf8('mundo'))).toBe(true);
    expect(subarray.equals(Bytes.fromUtf8('mundö'))).toBe(false);
    const copy = bytes.toUint8Array();
    copy.fill(0);
    expect(bytes.byteLength).toBe(10);
    expect(bytes.utf8()).toBe('hola mundo');
    const fresh = new Uint8Array([1]);
    const copied = Bytes.copy(fresh);
    fresh[0] = 2;
    expect(copied.toUint8Array()).toEqual(new Uint8Array([1]));
  });
});
