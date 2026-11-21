import { describe, expect, it } from 'vitest';

import { createDumpEncoder, decodeKey, encodeKey } from '../src/dump-encoder.ts';
import { SecretLeakError } from '../src/errors.ts';
import { SECRET_BRAND, SECRET_RENDERED, STREAM_BRAND } from '../src/types.ts';
import type { RawRunEvent, Secret } from '../src/types.ts';

const secret = (plaintext: string, hash = 'secret-hash'): Secret<string> => ({
  [SECRET_BRAND]: true,
  [SECRET_RENDERED]: plaintext,
  length: plaintext.length,
  hash,
  reveal: () => plaintext,
});

const enter = (facts: Readonly<Record<string, unknown>>, seq = 1): RawRunEvent => ({
  k: 'enter',
  seq,
  tMs: seq,
  stageId: 1,
  parentStageId: null,
  edgeKind: 'root',
  name: 'capture',
  facts,
});

describe('dump encoder', () => {
  it('escapes object-space keys on a round trip', () => {
    expect(encodeKey('$schema')).toBe('$$schema');
    expect(decodeKey(encodeKey('$ref'))).toBe('$ref');
    expect(decodeKey('name')).toBe('name');
  });

  it('redacts Secret values before property traversal and folds repeated references', () => {
    const encoder = createDumpEncoder({ detectRawSecretLeaks: true });
    const token = secret('super-secret-token');
    const events = encoder.encodeBatch([enter({ auth: token, repeated: token })]);
    expect(events[0]).toMatchObject({ k: 'obj', from: 0 });
    const object = events[0];
    if (object.k !== 'obj') throw new Error('expected object definitions');
    expect(object.nodes[1]).toEqual({
      $secret: { length: 18, hash: 'secret-hash', redacted: '*'.repeat(18) },
    });
    expect(events[1]).toMatchObject({ k: 'enter', facts: { $: 0 } });
    const facts = events[1];
    if (facts.k !== 'enter' || facts.facts === null || typeof facts.facts !== 'object'
      || Array.isArray(facts.facts) || !('$' in facts.facts) || typeof facts.facts.$ !== 'number')
      throw new Error('expected encoded facts reference');
    expect(object.nodes[facts.facts.$]).toEqual({ auth: { $: 1 }, repeated: { $: 1 } });
  });

  it('rejects registered plaintext in values and keys', () => {
    const encoder = createDumpEncoder({ detectRawSecretLeaks: true });
    encoder.registerSecretPlaintext('registered-secret');
    expect(() => encoder.encodeBatch([enter({ value: 'contains registered-secret here' })])).toThrowError(SecretLeakError);
    expect(() => encoder.encodeBatch([enter({ 'registered-secret': true })])).toThrowError(SecretLeakError);
  });

  it('preserves raw JSON, tagged primitives, and bytes', () => {
    const rawJSON = JSON as typeof JSON & { rawJSON: (text: string) => unknown };
    const encoder = createDumpEncoder({ detectRawSecretLeaks: false });
    const events = encoder.encodeBatch([enter({
      raw: rawJSON.rawJSON('9007199254740993'),
      negativeZero: -0,
      nan: Number.NaN,
      infinity: Number.POSITIVE_INFINITY,
      big: 9_007_199_254_740_993n,
      nothing: undefined,
      bytes: new Uint8Array([1, 2, 3]),
    })]);
    const block = events.find(event => event.k === 'obj');
    if (block?.k !== 'obj') throw new Error('expected object block');
    const facts = block.nodes[0] as Record<string, unknown>;
    const values = Object.values(facts).map(value => {
      if (typeof value !== 'object' || value === null || !Object.hasOwn(value, '$'))
        return value;
      return block.nodes[(value as { readonly $: number }).$];
    });
    expect(values).toEqual(expect.arrayContaining([
      { $rawJson: '9007199254740993' },
      { $number: '-0' },
      { $number: 'NaN' },
      { $number: 'Infinity' },
      { $bigint: '9007199254740993' },
      { $undefined: true },
      { $bytes: 'AQID' },
    ]));
    expect(block.nodes).toContainEqual({ $bytes: 'AQID' });
  });

  it('encodes cyclic error causes without recursion', () => {
    const encoder = createDumpEncoder({ detectRawSecretLeaks: false });
    const error = new Error('outer', { cause: undefined });
    error.cause = error;
    const events = encoder.encodeBatch([{ k: 'fail', seq: 1, tMs: 1, stageId: 1, error }]);
    const block = events.find(event => event.k === 'obj');
    if (block?.k !== 'obj') throw new Error('expected object block');
    expect(block.nodes[0]).toMatchObject({
      $error: { name: 'Error', message: 'outer', cause: { $: 0 } },
    });
  });

  it('bounds cross-batch string and byte sharing', () => {
    const encoder = createDumpEncoder({ shareStringsFrom: 4, maxSharedValues: 1, detectRawSecretLeaks: false });
    const first = encoder.encodeBatch([enter({ value: 'shared-value', bytes: new Uint8Array([1, 2]) })]);
    const second = encoder.encodeBatch([enter({ value: 'shared-value' }, 2)]);
    expect(second.some(event => event.k === 'obj')).toBe(true);
    expect(second.at(-1)).toMatchObject({ k: 'enter' });
    const third = encoder.encodeBatch([enter({ value: 'shared-value', bytes: new Uint8Array([1, 2]) }, 3)]);
    expect(third.some(event => event.k === 'obj')).toBe(true);
    const fourth = encoder.encodeBatch([enter({ value: 'shared-value' }, 4)]);
    expect(fourth.some(event => event.k === 'obj')).toBe(true);
    expect(first.length).toBeGreaterThan(0);
  });

  it('coalesces consecutive frames only for the same stream', () => {
    const encoder = createDumpEncoder({ detectRawSecretLeaks: false });
    const events = encoder.encodeBatch([
      { k: 'frame', seq: 1, tMs: 10, streamId: 7, value: { delta: 'a' } },
      { k: 'frame', seq: 2, tMs: 11, streamId: 7, value: { delta: 'b' } },
      { k: 'frame', seq: 3, tMs: 12, streamId: 8, value: { delta: 'c' } },
    ]);
    expect(events.filter(event => event.k === 'frames')).toHaveLength(2);
    expect(events[events.length - 1]).toMatchObject({ k: 'frames', streamId: 8 });
  });

  it('represents managed streams by stable id', () => {
    const encoder = createDumpEncoder({ detectRawSecretLeaks: false });
    const stream = { [STREAM_BRAND]: true as const, streamId: 41 };
    const events = encoder.encodeBatch([enter({ stream })]);
    const block = events.find(event => event.k === 'obj');
    if (block?.k !== 'obj') throw new Error('expected object block');
    expect(block.nodes).toContainEqual({ stream: { $stream: 41 } });
  });
});
