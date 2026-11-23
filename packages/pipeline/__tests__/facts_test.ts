import { describe, expect, it } from 'vitest';

import { collectStreams, freezeValue } from '../src/facts.ts';
import { Bytes, compose, defineEnding, InvalidFactValueError, run, secret, snapshotError } from '../src/index.ts';
import type { ManagedStream, RawJson } from '../src/index.ts';

describe('fact values', () => {
  it('freezes the full graph by identity and memoizes validated objects', () => {
    const raw = (JSON as JSON & { rawJSON(value: string): RawJson }).rawJSON('123');
    let enumerations = 0;
    const nested = new Proxy({ key: ['a', undefined, raw] }, {
      ownKeys: target => {
        enumerations++;
        return Reflect.ownKeys(target);
      },
    });
    const facts = { nested, reference: nested };
    expect(freezeValue(facts)).toBe(facts);
    const first = enumerations;
    expect(first).toBeGreaterThan(0);
    const next = { ...facts, bytes: Bytes.empty, secret: secret('value') };
    expect(freezeValue(next)).toBe(next);
    expect(enumerations).toBe(first);
    expect(Object.isFrozen(nested.key)).toBe(true);
    expect(nested.key[2]).toBe(raw);
  });

  it('enumerates a large frozen payload once even when it travels beside a stream', async () => {
    type Output = { stream: ManagedStream<number> };
    const pipeline = compose<Output>()('stream', {
      entry: [], exit: ['stream'], stages: [],
      ending: defineEnding<{}, Output>({
        name: 'stream', request: { needs: [] }, return: { provides: ['stream'] },
        execute: async (_facts, scope) => ({ stream: scope.createStream({ label: 'body', async *iterate() { yield 1; } }) }),
      }),
    });
    const handle = run(pipeline, {}, { services: {}, finalizationTimeoutMs: 200 });
    const { stream } = await handle.result;
    let enumerations = 0;
    const entries = Array.from({ length: 1_000 }, (_, index) => new Proxy({ index }, {
      ownKeys: target => {
        enumerations++;
        return Reflect.ownKeys(target);
      },
    }));
    type Payload = { entries: typeof entries; self?: Payload };
    const payload = new Proxy<Payload>({ entries }, {
      ownKeys: target => {
        enumerations++;
        return Reflect.ownKeys(target);
      },
    });
    payload.self = payload;
    try {
      const facts = freezeValue({ payload, stream });
      const beforeCollecting = enumerations;
      expect(collectStreams(facts)).toEqual(new Set([stream]));
      expect(enumerations - beforeCollecting).toBe(entries.length + 1);
      const afterCollecting = enumerations;
      for (let index = 0; index < 20; index++) {
        expect(collectStreams(facts)).toEqual(new Set([stream]));
        expect(collectStreams(freezeValue({ payload, stream, index }))).toEqual(new Set([stream]));
      }
      expect(enumerations).toBe(afterCollecting);
    } finally {
      await stream.close();
      await handle.done;
    }
  });

  it.each([
    new Uint8Array(), new ArrayBuffer(0), new Error('test'), new Map(), new Set(), new Date(), new Headers(),
    new URL('https://example.test/'), new Blob(), new ReadableStream(), Promise.resolve(), () => undefined, Symbol(),
  ])('rejects disallowed values and reports the full path (%s)', value => {
    expect(() => freezeValue({ nested: [value] })).toThrow(InvalidFactValueError);
    expect(() => freezeValue({ nested: [value] })).toThrow('facts.nested[0]');
  });

  it('validates own descriptors without evaluating accessors', () => {
    const value = { get key() { throw new Error('unexpected getter'); } };
    expect(() => freezeValue(value)).toThrow('facts.key: accessors');
    expect(() => freezeValue({ [Symbol('key')]: true })).toThrow('symbol key');
    expect(() => freezeValue(new class {}())).toThrow('plain object');
    const hidden = Object.defineProperty({}, 'hidden', { value: 1 });
    expect(() => freezeValue(hidden)).toThrow('facts.hidden: non-enumerable');
  });

  it('snapshots aggregate errors and causes with cycles without mutating thrown errors', () => {
    const fact = { detail: { phase: 'wire' } };
    const cause = new TypeError('endpoint');
    const error = Object.assign(new AggregateError([cause, 16], 'failed', { cause }), { fact, invalid: new Date(0) });
    Object.defineProperty(cause, 'cause', { value: error });
    const snapshot = snapshotError(error);
    expect(snapshot).toMatchObject({
      name: 'AggregateError', message: 'failed',
      cause: { name: 'TypeError', message: 'endpoint', cause: { message: '[Circular error]' } },
      errors: [{ name: 'TypeError' }, { message: '16' }],
      fields: { fact, invalid: String(error.invalid) },
    });
    expect(snapshot.errors?.[0]).toBe(snapshot.cause);
    expect(snapshot.fields?.fact).not.toBe(fact);
    expect(Object.isFrozen(snapshot.fields?.fact)).toBe(true);
    expect(Object.isFrozen(fact)).toBe(false);
    expect(Object.isFrozen(fact.detail)).toBe(false);
    fact.detail.phase = 'reassigned';
    expect(snapshot.fields?.fact).toEqual({ detail: { phase: 'wire' } });
    error.stack = 'reassigned';
    expect(snapshot.stack).toContain('AggregateError: failed');
  });
});
