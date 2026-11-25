import { inspect } from 'node:util';

import { describe, expect, it } from 'vitest';

import { host } from './run-fixture.ts';
import { factSpace, run, Secret } from '../src/index.ts';
import type { Deferred, ManagedStream } from '../src/index.ts';
import { revealSecret } from '../src/transport.ts';

const none = { needs: [], provides: [], consumes: [] } as const;

describe('facts', () => {
  it('freezes complete handoffs and shares unchanged nested objects by identity', async () => {
    type Payload = { changed: { value: number }; shared: { keep: string }; cycle?: Payload };
    const { defineStage, compose } = factSpace<{
      'request.payload': Payload;
      'response.payload': Payload;
    }>();
    const input: Payload = { changed: { value: 1 }, shared: { keep: 'same' } };
    input.cycle = input;
    const request = { 'request.payload': input, 'request.unlisted': { object: { present: true } } };
    const stage = defineStage({
      name: 'rebuild',
      through: {
        request: { ...none, needs: ['request.payload'], provides: ['request.payload'] },
        response: { ...none, needs: ['response.payload'] },
      },
      execute: async (facts, scope) => {
        expect(facts).toBe(request);
        expect(facts['request.payload']).toBe(input);
        expect(Object.isFrozen(facts)).toBe(true);
        expect(Object.isFrozen(request['request.unlisted'].object)).toBe(true);
        expect(() => { facts['request.payload'].changed.value = 2; }).toThrow(TypeError);
        return await scope.next({
          ...facts,
          'request.payload': { ...input, changed: { ...input.changed, value: 2 } },
        });
      },
    });
    const ending = defineStage({
      name: 'echo',
      request: { needs: ['request.payload'] },
      return: { provides: ['response.payload'] },
      execute: async facts => {
        expect(Object.isFrozen(facts['request.payload'].changed)).toBe(true);
        return { 'response.payload': facts['request.payload'] };
      },
    });
    const pipeline = compose('immutable', { entry: ['request.payload'], exit: ['response.payload'], stages: [stage], ending });
    const recording = host({});
    const running = run(pipeline, request, recording.options);
    const answer = await running.result;
    expect(Object.isFrozen(answer)).toBe(true);
    expect(answer['response.payload'].changed).toEqual({ value: 2 });
    expect(answer['response.payload'].changed).not.toBe(input.changed);
    expect(answer['response.payload'].shared).toBe(input.shared);
    expect(answer['response.payload'].cycle).toBe(input);
  });

  it('freezes frame and deferred objects in place, preserving typed array identity', async () => {
    const nested = { body: { bytes: Uint8Array.of(3, 5), empty: new Uint8Array() } };
    type Content = typeof nested;
    const { defineStage, compose } = factSpace<{
      'response.body': ManagedStream<Content, string>;
      'response.deferred': Deferred<Content>;
    }>();
    const frame = { ok: true, value: nested } as const;
    const deferred = { body: { bytes: Uint8Array.of(7, 9), empty: new Uint8Array() } };
    const ending = defineStage({
      name: 'freeze-values',
      request: none,
      return: { provides: ['response.body', 'response.deferred'] },
      execute: async (_facts, scope) => ({
        'response.body': scope.createStream<Content, string>(async function* () { yield frame; }),
        'response.deferred': scope.createDeferred(async () => deferred),
      }),
    });
    const pipeline = compose('freeze-values', { entry: [], exit: ['response.body', 'response.deferred'], stages: [], ending });
    const recording = host({});
    const running = run(pipeline, {}, recording.options);
    const answer = await running.result;
    const [received] = await Array.fromAsync(running.read(answer['response.body']));
    const resolved = await running.read(answer['response.deferred']);
    expect(received).toBe(frame);
    expect(resolved).toBe(deferred);
    for (const object of [frame, nested, nested.body, nested.body.empty, deferred, deferred.body, deferred.body.empty]) {
      expect(Object.isFrozen(object)).toBe(true);
    }
    for (const bytes of [nested.body.bytes, deferred.body.bytes]) expect(Object.isFrozen(bytes)).toBe(false);
    expect(resolved.body.bytes).toBe(deferred.body.bytes);
    await running.done;
  });

  it('freezes the wrappers of Map, Set, and Date while preserving their JavaScript methods', async () => {
    const { defineStage, compose } = factSpace<{ 'request.contents': [Map<string, object>, Set<object>, Date] }>();
    const ending = defineStage({
      name: 'contents',
      request: { needs: ['request.contents'] },
      return: { provides: [] },
      execute: async () => ({}),
    });
    const item = { nested: {} };
    const contents: [Map<string, object>, Set<object>, Date] = [new Map([['item', item]]), new Set([item]), new Date(0)];
    const pipeline = compose('contents', { entry: ['request.contents'], exit: [], stages: [], ending });
    await run(pipeline, { 'request.contents': contents }, host({}).options).done;
    expect(Object.isFrozen(item.nested)).toBe(true);
    expect(contents.every(Object.isFrozen)).toBe(true);
    contents[0].clear();
    contents[1].clear();
    contents[2].setTime(1);
    expect([contents[0].size, contents[1].size, contents[2].getTime()]).toEqual([0, 0, 1]);
  });
});

describe('Secret', () => {
  it('retains the mark through mapping and redacts inspection and JSON', () => {
    const secret = Secret.from('do-not-print');
    const auth = secret.map(value => `Bearer ${value}`);
    expect(auth).toBeInstanceOf(Secret);
    expect(revealSecret(auth)).toBe('Bearer do-not-print');
    const description = auth.describe();
    expect(description).toEqual({ length: 19, redacted: '*******************', hash: expect.stringMatching(/^0x[0-9a-f]{16}$/) });
    expect(JSON.parse(JSON.stringify(auth))).toEqual(description);
    expect(inspect(auth)).toBe(inspect(description));
    expect(Object.hasOwn(Secret.prototype, 'reveal')).toBe(false);
  });
});
