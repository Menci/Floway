import { describe, expect, it } from 'vitest';

import { createRunReader, defer, encodeRun, secret, streamFact } from '../src/index.ts';
import type { DumpEvent } from '../src/index.ts';

const entered = (facts: Record<string, unknown>): DumpEvent[] => encodeRun([
  { type: 'stage.entered', stageId: 1, name: 'read', parentStageId: null, facts },
]);

describe('run reader', () => {
  it('preserves cycles and shared identities across facts and frames', () => {
    const shared: Record<string, unknown> = { value: 1 };
    const array: unknown[] = [shared];
    shared['array'] = array;
    array.push(array);
    const read = createRunReader();
    const events = encodeRun([
      { type: 'stage.entered', stageId: 1, name: 'read', parentStageId: null, facts: { a: shared, b: shared, array } },
      { type: 'stream.frame', streamId: 1, frames: [shared] },
    ]);
    const first = events.map(read).find(value => value?.facts !== undefined)!.facts!;
    const frames = read(events.at(-1)!)!.frames!;
    expect(first['a']).toBe(first['b']);
    expect((first['a'] as Record<string, unknown>)['array']).toBe(first['array']);
    expect((first['array'] as unknown[])[1]).toBe(first['array']);
    expect(frames[0]).toBe(first['a']);
    const event = events.find(value => value.type === 'stage.entered')!;
    const ref = event.facts!['a'] as { $: number };
    expect(read.decode(ref)).toBe(first['a']);
    expect(read.node(ref.$)).toEqual({ value: 1, array: expect.any(Object) });
  });

  it('describes collection and Error cycles without recreating live values', () => {
    const map = new Map<unknown, unknown>();
    const set = new Set<unknown>();
    const error = new Error('failed');
    Object.defineProperty(error, 'cause', { value: error });
    map.set(map, set);
    set.add(map);
    const read = createRunReader();
    const facts = entered({ map, set, error, date: new Date(42), invalidDate: new Date(NaN) })
      .map(read).find(value => value?.facts !== undefined)!.facts!;
    const decodedMap = facts['map'] as { map: unknown[][] };
    const decodedSet = facts['set'] as { set: unknown[] };
    const decodedError = facts['error'] as { error: Record<string, unknown> };
    expect(decodedMap.map[0]![0]).toBe(decodedMap);
    expect(decodedMap.map[0]![1]).toBe(decodedSet);
    expect(decodedSet.set[0]).toBe(decodedMap);
    expect(decodedError.error['cause']).toBe(decodedError);
    expect(decodedError.error).toMatchObject({ name: 'Error', message: 'failed', stack: error.stack });
    expect(facts['date']).toEqual({ date: 42 });
    expect(facts['invalidDate']).toEqual({ date: NaN });
  });

  it('shares complete byte values and preserves scalar tags and escaped keys', () => {
    const bytes = new Uint8Array([1, 2]);
    const object = Object.fromEntries([['__proto__', 'ordinary'], ['$schema', 'schema'], ['$$', 'dollars']]);
    const read = createRunReader();
    const facts = entered({ bytes, buffer: bytes.slice().buffer, object, absent: undefined, nan: NaN, inf: Infinity, negative: -Infinity, big: 42n, secret: secret('credential'), stream: streamFact(7), raw: new ReadableStream() })
      .map(read).find(value => value?.facts !== undefined)!.facts!;
    expect(facts['buffer']).toBe(facts['bytes']);
    expect(facts['bytes']).toEqual({ bytes: 'AQI=' });
    expect(facts['object']).toEqual(object);
    expect(Object.getPrototypeOf(facts['object'])).toBe(Object.prototype);
    expect(facts).toMatchObject({ absent: undefined, nan: NaN, inf: Infinity, negative: -Infinity, big: 42n, stream: { stream: 7 }, raw: { readableStream: true } });
    expect(facts['secret']).toMatchObject({ redacted: '**********', length: 10 });
  });

  it('associates settlement with the original deferred handle', async () => {
    const deferred = defer(Promise.resolve({ answer: 42 }));
    const outcome = { status: 'fulfilled', value: await deferred } as const;
    const events = encodeRun([
      { type: 'stage.entered', stageId: 1, name: 'read', parentStageId: null, facts: { result: deferred } },
      { type: 'deferred.settled', deferred, outcome },
    ]);
    const read = createRunReader();
    let handle: unknown;
    for (const event of events) {
      const value = read(event);
      if (value?.facts) handle = value.facts['result'];
      if (value?.outcome) expect(value.deferred).toBe(handle);
    }
    const stage = events.find(value => value.type === 'stage.entered')!;
    const id = (stage.facts!['result'] as { $: number }).$;
    expect(read.settlement(id)).toEqual(outcome);
    expect(read.settlement(id + 100)).toBeUndefined();
  });

  it('rejects absent references while folding omitted state without a replacement', () => {
    const read = createRunReader();
    expect(() => read.decode({ $: 9 })).toThrow('no event carried');
    expect(read({ type: 'stage.entered', stageId: 1, name: 'folded', parentStageId: null })).toEqual({});
    expect(read({ type: 'stream.end', streamId: 1 })).toEqual({});
  });
});
