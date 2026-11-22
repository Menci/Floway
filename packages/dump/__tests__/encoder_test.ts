import { describe, expect, it } from 'vitest';

import { done, enter, leave, runEvent } from './fixtures.ts';
import { createDumpDecoder, isDecodedRawJson, isDecodedSecret, isDecodedStreamRef, createDumpEncoder } from '../src/index.ts';
import { Bytes, secret, storedSecret } from '@floway-dev/pipeline';
import type { FactValue, RawJson } from '@floway-dev/pipeline';

describe('dump encoding', () => {
  it('escapes fact keys and preserves tagged values, bytes, and identity through NDJSON', () => {
    const bytes = Bytes.copy(Uint8Array.of(0, 0xFE, 0xFF));
    const token = secret('private credential');
    const error = { name: 'Error', message: 'failed', cause: undefined };
    const raw = (JSON as JSON & { rawJSON: (text: string) => RawJson }).rawJSON('9007199254740993');
    const facts = Object.freeze({
      ['$']: '$ inside data',
      $stream: 22,
      $$bytes: 'plain',
      ['__proto__']: 'owned',
      undefined,
      nan: NaN,
      negativeZero: -0,
      positive: Infinity,
      negative: -Infinity,
      integer: 9_007_199_254_740_993n,
      raw,
      bytes,
      again: bytes,
      token,
      error,
    });
    const encoder = createDumpEncoder();
    const encoded = encoder.encodeBatch([runEvent, enter(2, 1, facts), leave(3, 1, facts), done(4)]);
    const ndjson = encoded.map(event => JSON.stringify(event)).join('\n');
    expect(ndjson).toContain('"$$":"$ inside data"');
    expect(ndjson).toContain('"$$stream":22');
    expect(ndjson).toContain('"$$$bytes":"plain"');
    expect(ndjson).toContain('"$rawJson":"9007199254740993"');
    expect(ndjson.split('"$bytes":"AP7/"')).toHaveLength(2);
    expect(ndjson).not.toContain('private credential');

    const decoder = createDumpDecoder();
    decoder.pushNdjsonChunk(ndjson);
    const result = decoder.finish().stages.get(1)!;
    expect(result.facts).toBe(result.responseFacts);
    expect(result.facts.$).toBe(facts.$);
    expect(result.facts.$$bytes).toBe('plain');
    expect(result.facts.__proto__).toBe('owned');
    expect(Object.getPrototypeOf(result.facts)).toBe(Object.prototype);
    expect(isDecodedStreamRef(result.facts)).toBe(false);
    expect(Object.hasOwn(result.facts, 'undefined')).toBe(true);
    expect(result.facts.undefined).toBeUndefined();
    expect(result.facts.nan).toBeNaN();
    expect(result.facts.negativeZero).toBe(-0);
    expect(result.facts.positive).toBe(Infinity);
    expect(result.facts.negative).toBe(-Infinity);
    expect(result.facts.integer).toBe(facts.integer);
    expect(result.facts.raw).toEqual({ rawJSON: '9007199254740993' });
    expect(isDecodedRawJson(result.facts.raw)).toBe(true);
    expect(result.facts.error).toEqual(error);
    expect(result.facts.bytes).toBe(result.facts.again);
    expect((result.facts.bytes as Bytes).equals(bytes)).toBe(true);
    expect(result.facts.token).toEqual({ $secret: storedSecret(token) });
    expect(isDecodedSecret(result.facts.token)).toBe(true);
  });

  it('assigns contiguous ids before descending into cycles and interns distinct long string occurrences', () => {
    const cycle: Record<string, FactValue> = {};
    cycle.self = cycle;
    cycle.array = Object.freeze([cycle]);
    Object.freeze(cycle);
    const long = 'a long value'.repeat(10);
    const first = Object.freeze({ cycle, nested: Object.freeze({ long }) });
    const second = Object.freeze({ cycle, nested: Object.freeze({ long: `#${long}`.slice(1) }) });
    const encoder = createDumpEncoder({ shareStringsFrom: 12 });
    const encoded = [...encoder.encodeBatch([runEvent, enter(2, 1, first)]), ...encoder.encodeBatch([leave(3, 1, second)])];
    let lastId = 0;
    const assertReferences = (value: unknown): void => {
      if (typeof value !== 'object' || value === null) return;
      if ('$' in value) {
        expect(value.$).toBeGreaterThan(0);
        expect(value.$).toBeLessThanOrEqual(lastId);
      } else {
        for (const child of Object.values(value)) assertReferences(child);
      }
    };
    for (const event of encoded) {
      if (event.k === 'obj') {
        expect(event.from).toBe(lastId + 1);
        lastId += event.nodes.length;
      }
      assertReferences(event);
    }
    expect(encoded.flatMap(event => event.k === 'obj' ? event.nodes : []).filter(node => node === long)).toHaveLength(1);
    const decoder = createDumpDecoder();
    decoder.pushEvents(encoded);
    const stage = decoder.model.stages.get(1)!;
    expect(stage.facts.cycle).toBe(stage.responseFacts!.cycle);
    const decoded = stage.facts.cycle as { self: unknown; array: unknown[] };
    expect(decoded.self).toBe(decoded);
    expect(decoded.array[0]).toBe(decoded);
  });

  it('rejects explicitly registered plaintext in leak detection mode', () => {
    const encoder = createDumpEncoder({ detectRawSecretLeaks: true });
    const token = 'raw-test-token';
    encoder.registerSecretPlaintext(token);
    expect(() => encoder.encodeBatch([runEvent, enter(2, 1, { token: secret(token) })])).not.toThrow();
    expect(() => encoder.encodeBatch([leave(3, 1, { value: `prefix ${token}` })])).toThrow('Registered secret plaintext reached the dump');
  });

  it('batches contiguous frames per stream and preserves interleaved sequence order', () => {
    const encoder = createDumpEncoder();
    const encoded = encoder.encodeBatch([
      { k: 'frame', seq: 1, tMs: 1, streamId: 1, value: 'a' },
      { k: 'frame', seq: 2, tMs: 2, streamId: 1, value: 'b' },
      { k: 'frame', seq: 3, tMs: 3, streamId: 2, value: 'c' },
      { k: 'frame', seq: 4, tMs: 4, streamId: 1, value: 'd' },
    ]);
    expect(encoded).toEqual([
      { k: 'frames', streamId: 1, frames: [{ seq: 1, tMs: 1, v: 'a' }, { seq: 2, tMs: 2, v: 'b' }] },
      { k: 'frames', streamId: 2, frames: [{ seq: 3, tMs: 3, v: 'c' }] },
      { k: 'frames', streamId: 1, frames: [{ seq: 4, tMs: 4, v: 'd' }] },
    ]);
  });
});
