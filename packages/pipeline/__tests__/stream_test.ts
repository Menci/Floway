import { describe, expect, it } from 'vitest';

import { factSpace, isManagedStream, move, run } from '../src/index.ts';
import type { Deferred, ManagedStream, Result, RunEvent } from '../src/index.ts';
import { StreamResource, streamsIn } from '../src/stream.ts';

type Frame = Result<string, string>;
type Stream = ManagedStream<string, string>;

interface Space {
  readonly 'request.mode': string;
  readonly 'request.stream': Stream;
  readonly 'response.stream': Stream;
  readonly 'response.value': string;
  readonly 'response.deferred': Deferred<string>;
}

const { compose, defineStage } = factSpace<Space>();
const untouched = { needs: [], provides: [], consumes: [] } as const;
const streamResponse = { ...untouched, needs: ['response.stream'] } as const;
const valueResponse = { ...untouched, needs: ['response.value'] } as const;
const success = (value: string): Frame => ({ ok: true, value });
const failure = (error: string): Frame => ({ ok: false, error });

const createResource = () => new StreamResource(new Set(), async function* () { yield success('frame'); }, {
  emit: () => {},
  finishProducer: () => {},
  panic: error => { throw error; },
});

describe('stream discovery', () => {
  it('reuses unchanged frozen subtrees as fact paths are rebuilt', () => {
    const stream = createResource();
    expect(isManagedStream(stream.handle)).toBe(true);
    expect(isManagedStream({ ...stream.handle })).toBe(false);
    let scans = 0;
    const shared = new Proxy({ stream: stream.handle }, {
      ownKeys: object => {
        scans += 1;
        return Reflect.ownKeys(object);
      },
    });
    const original = move({ shared, updated: { value: 'before' } });
    scans = 0;
    expect(streamsIn({ value: original })).toEqual(new Set([stream]));
    expect(scans).toBe(1);

    const revised = move({ ...original, updated: { value: 'after' } });
    expect(streamsIn({ value: revised })).toEqual(new Set([stream]));
    expect(scans).toBe(1);
  });

  it('never caches incomplete cycles or an unfrozen fact dictionary', () => {
    const stream = createResource();
    const source: { stream?: Stream; next?: object } = {};
    const target = { next: source };
    source.next = target;
    source.stream = stream.handle;
    move(source);
    const facts: Record<string, unknown> = { value: source };
    expect(streamsIn(facts)).toEqual(new Set([stream]));
    facts.value = target;
    expect(streamsIn(facts)).toEqual(new Set([stream]));
    facts.value = move({});
    expect(streamsIn(facts).size).toBe(0);
  });
});

const terminal = (produce: () => AsyncIterable<Frame>) => defineStage({
  name: 'producer',
  request: { needs: [] },
  return: { provides: ['response.stream'] },
  execute: async (_facts, scope) => ({ 'response.stream': scope.createStream<string, string>(produce) }),
});

describe('managed stream iteration', () => {
  it('yields whole Result items, emits their identities, and joins native done', async () => {
    const records: RunEvent[] = [];
    const gate = Promise.withResolvers<void>();
    const frame = success('value');
    const err = failure('transport stopped');
    const pipeline = compose('result-items', {
      entry: [], exit: ['response.stream'], stages: [],
      ending: terminal(async function* () {
        yield frame;
        yield err;
        await gate.promise;
      }),
    });
    const request = run(pipeline, {}, { services: {}, events: event => { records.push(event); } });
    const stream = (await request.result)['response.stream'];
    const iterator = stream[Symbol.asyncIterator]();
    expect((await iterator.next()).value).toBe(frame);
    expect((await iterator.next()).value).toBe(err);
    expect(records.filter(event => event.type === 'stream.end')).toHaveLength(0);
    let completed = false;
    const joined = request.done.then(() => { completed = true; });
    const draining = iterator.next();
    await Promise.resolve();
    expect(completed).toBe(false);
    gate.resolve();
    await expect(draining).resolves.toEqual({ done: true, value: undefined });
    await joined;
    const frames = records.filter(record => record.type === 'stream.frame');
    expect(frames.map(event => event.item)).toEqual([frame, err]);
    expect(frames.map(event => event.stream)).toEqual([stream, stream]);
    expect(records.filter(event => event.type === 'stream.end')).toEqual([{ type: 'stream.end', stream }]);
  });

  it('panics on any yield after an Err', async () => {
    const pipeline = compose('post-error-yield', {
      entry: [], exit: ['response.stream'], stages: [],
      ending: terminal(async function* () {
        yield failure('ordinary failure');
        yield success('invalid frame');
      }),
    });
    const request = run(pipeline, {}, { services: {} });
    const iterator = (await request.result)['response.stream'][Symbol.asyncIterator]();
    await expect(iterator.next()).resolves.toEqual({ done: false, value: failure('ordinary failure') });
    await expect(iterator.next()).rejects.toThrow('yielded after an Err');
    await expect(request.done).rejects.toThrow('yielded after an Err');
  });

  it('panics on early return without resuming the producer', async () => {
    let resumed = false;
    const pipeline = compose('early-return', {
      entry: [], exit: ['response.stream'], stages: [],
      ending: terminal(async function* () {
        try {
          yield success('first');
          yield success('second');
        } finally {
          resumed = true;
        }
      }),
    });
    const request = run(pipeline, {}, { services: {} });
    const iterator = (await request.result)['response.stream'][Symbol.asyncIterator]();
    await iterator.next();
    await expect(iterator.return!()).rejects.toThrow('before native done');
    await expect(request.done).rejects.toThrow('before native done');
    expect(resumed).toBe(false);
  });

  it('returns done from an iterator after native exhaustion', async () => {
    const pipeline = compose('complete-return', {
      entry: [], exit: ['response.stream'], stages: [],
      ending: terminal(async function* () { yield success('complete'); }),
    });
    const request = run(pipeline, {}, { services: {} });
    const iterator = (await request.result)['response.stream'][Symbol.asyncIterator]();
    await iterator.next();
    await expect(iterator.next()).resolves.toEqual({ done: true, value: undefined });
    await expect(iterator.return!()).resolves.toEqual({ done: true, value: undefined });
    await request.done;
  });

  it('panics if the owner abandons a created stream at settlement', async () => {
    const pipeline = compose('abandoned', {
      entry: [], exit: ['response.value'], stages: [],
      ending: defineStage({
        name: 'abandons',
        request: { needs: [] },
        return: { provides: ['response.value'] },
        execute: async (_facts, scope) => {
          scope.createStream<string, string>(async function* () { yield success('abandoned'); });
          return { 'response.value': 'appeared to succeed' };
        },
      }),
    });
    const request = run(pipeline, {}, { services: {} });
    await expect(request.result).rejects.toThrow('abandoned 1 owned stream');
    await expect(request.done).rejects.toThrow('abandoned 1 owned stream');
  });

  it('keeps the original panic first when the same owner also abandons a stream', async () => {
    const cause = new Error('original');
    const pipeline = compose('combined', {
      entry: [], exit: ['response.value'], stages: [],
      ending: defineStage({
        name: 'panic-with-leak',
        request: { needs: [] },
        return: { provides: ['response.value'] },
        execute: async (_facts, scope) => {
          scope.createStream<string, string>(async function* () { yield success('abandoned'); });
          throw cause;
        },
      }),
    });
    const request = run(pipeline, {}, { services: {} });
    const error: unknown = await request.done.catch(reason => reason);
    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors).toEqual([cause, expect.objectContaining({ message: expect.stringContaining('abandoned 1') })]);
    await expect(request.result).rejects.toBe(error);
  });
});

describe('stream producers and wrappers', () => {
  it('keeps a stage-created deferred open through its producer’s native drain', async () => {
    const pipeline = compose('producer-deferred', {
      entry: [], exit: ['response.stream', 'response.deferred'], stages: [],
      ending: defineStage({
        name: 'producer-deferred',
        request: { needs: [] },
        return: { provides: ['response.stream', 'response.deferred'] },
        execute: async (_facts, scope) => {
          const handle = scope.deferred<string>();
          const stream = scope.createStream<string, string>(async function* () {
            yield success('before settlement');
            handle.resolve('after settlement');
          });
          return { 'response.stream': stream, 'response.deferred': handle.deferred };
        },
      }),
    });
    const request = run(pipeline, {}, { services: {} });
    const answer = await request.result;
    const iterator = answer['response.stream'][Symbol.asyncIterator]();
    await expect(iterator.next()).resolves.toEqual({ done: false, value: success('before settlement') });
    await expect(iterator.next()).resolves.toEqual({ done: true, value: undefined });
    await expect(answer['response.deferred'].promise).resolves.toBe('after settlement');
    await request.done;
  });

  it('yields an outcome and drains its source before reporting wrapper done', async () => {
    const sourceClose = Promise.withResolvers<void>();
    const records: RunEvent[] = [];
    let sourceHandle!: Stream;
    const wrap = defineStage({
      name: 'wrap',
      through: { request: untouched, response: { ...streamResponse, provides: ['response.stream'] } },
      execute: async (facts, scope) => {
        const answer = await scope.next(facts);
        sourceHandle = answer['response.stream'];
        return {
          ...answer,
          'response.stream': scope.wrapStream<string, string, string, string>(sourceHandle, async function* (source) {
            for await (const item of source) {
              if (!item.ok) yield failure(`wrapped: ${item.error}`);
            }
          }),
        };
      },
    });
    const pipeline = compose('wrap-drain', {
      entry: [], exit: ['response.stream'], stages: [wrap],
      ending: terminal(async function* () {
        yield failure('ordinary');
        await sourceClose.promise;
      }),
    });
    const request = run(pipeline, {}, { services: {}, events: event => { records.push(event); } });
    const outer = (await request.result)['response.stream'];
    const iterator = outer[Symbol.asyncIterator]();
    await expect(iterator.next()).resolves.toEqual({ done: false, value: failure('wrapped: ordinary') });
    expect(records.filter(event => event.type === 'stream.end')).toHaveLength(0);
    sourceClose.resolve();
    await expect(iterator.next()).resolves.toEqual({ done: true, value: undefined });
    await request.done;
    expect(records.filter(event => event.type === 'stream.end').map(event => event.stream)).toEqual([sourceHandle, outer]);
  });

  it('panics on direct iteration after transferring a source to a wrapper', async () => {
    const wrap = defineStage({
      name: 'bad-direct-iteration',
      through: { request: untouched, response: { ...streamResponse, provides: ['response.stream'] } },
      execute: async (facts, scope) => {
        const answer = await scope.next(facts);
        const source = answer['response.stream'];
        const wrapped = scope.wrapStream(source, async function* (items) { yield* items; });
        source[Symbol.asyncIterator]();
        return { ...answer, 'response.stream': wrapped };
      },
    });
    const pipeline = compose('bad-direct', {
      entry: [], exit: ['response.stream'], stages: [wrap],
      ending: terminal(async function* () { yield success('source'); }),
    });
    const error: unknown = await run(pipeline, {}, { services: {} }).done.catch(reason => reason);
    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors[0]).toEqual(expect.objectContaining({
      message: expect.stringContaining('transferred to a wrapper'),
    }));
  });

  it('panics when a wrapper reports done without exhausting its source', async () => {
    const wrap = defineStage({
      name: 'bad-drain',
      through: { request: untouched, response: { ...streamResponse, provides: ['response.stream'] } },
      execute: async (facts, scope) => {
        const answer = await scope.next(facts);
        return {
          ...answer,
          'response.stream': scope.wrapStream(answer['response.stream'], async function* () { yield failure('early'); }),
        };
      },
    });
    const pipeline = compose('bad-drain', {
      entry: [], exit: ['response.stream'], stages: [wrap],
      ending: terminal(async function* () { yield success('undrained'); }),
    });
    const request = run(pipeline, {}, { services: {} });
    const iterator = (await request.result)['response.stream'][Symbol.asyncIterator]();
    await iterator.next();
    await expect(iterator.next()).rejects.toThrow('native done before its source');
    await expect(request.done).rejects.toThrow('native done before its source');
  });

  it.each([false, true])('uses its own continuation scope after execute (stale: %s)', async stale => {
    const stage = defineStage({
      name: 'producer-next',
      through: { request: untouched, response: streamResponse },
      return: { provides: ['response.stream'] },
      execute: async (facts, scope) => ({
        'response.stream': scope.createStream<string, string>(async function* (producer) {
          const answer = await (stale ? scope : producer).next(facts);
          yield* answer['response.stream'];
        }),
      }),
    });
    const pipeline = compose('producer-scope', {
      entry: [], exit: ['response.stream'], stages: [stage],
      ending: terminal(async function* () { yield success('round'); }),
    });
    const request = run(pipeline, {}, { services: {} });
    const iterator = (await request.result)['response.stream'][Symbol.asyncIterator]();
    if (stale) {
      await expect(iterator.next()).rejects.toThrow('scope has settled');
      await expect(request.done).rejects.toThrow('scope has settled');
    } else {
      await expect(iterator.next()).resolves.toEqual({ done: false, value: success('round') });
      await expect(iterator.next()).resolves.toEqual({ done: true, value: undefined });
      await request.done;
    }
  });
});

describe('streaming child calls and abort', () => {
  it('preserves pending I/O through propagated panic until the host aborts', async () => {
    const host = new AbortController();
    const reading = Promise.withResolvers<void>();
    const observed = Promise.withResolvers<unknown>();
    const ioStopped = Promise.withResolvers<void>();
    const events: RunEvent[] = [];
    const bug = new Error('sibling panic');
    let pendingSignal!: AbortSignal;
    let staleAbort!: () => void;
    const ending = defineStage({
      name: 'panic-or-stream',
      request: { needs: ['request.mode'] },
      return: { provides: ['response.stream'] },
      execute: async (facts, scope) => {
        if (facts['request.mode'] === 'panic') throw bug;
        pendingSignal = scope.signal;
        return {
          'response.stream': scope.createStream<string, string>(async function* (producer) {
            reading.resolve();
            await new Promise<void>(resolve => { producer.signal.addEventListener('abort', () => resolve(), { once: true }); });
            ioStopped.resolve();
            yield failure('host abort');
          }),
        };
      },
    });
    const owner = defineStage({
      name: 'holding-owner',
      through: {
        request: { ...untouched, needs: ['request.mode'] },
        response: { ...streamResponse, consumes: ['response.stream'], provides: ['response.value'] },
      },
      execute: async (facts, scope) => {
        const { 'response.stream': stream, ...rest } = await scope.next(facts);
        const iterator = stream[Symbol.asyncIterator]();
        try {
          await iterator.next();
        } catch (error) {
          observed.resolve(error);
          throw error;
        }
        return { ...rest, 'response.value': 'complete' };
      },
    });
    const parent = defineStage({
      name: 'panic-forks',
      through: { request: { ...untouched, provides: ['request.mode'] }, response: valueResponse },
      execute: async (facts, scope) => {
        const pending = scope.next({ ...facts, 'request.mode': 'hold' });
        staleAbort = () => { scope.abort(pending); };
        await reading.promise;
        return await scope.next({ ...facts, 'request.mode': 'panic' });
      },
    });
    const pipeline = compose('host-owned-panic-abort', {
      entry: [], exit: ['response.value'], stages: [parent, owner], ending,
    });
    const request = run(pipeline, {}, { services: {}, signal: host.signal, events: event => { events.push(event); } });
    await expect(request.result).rejects.toBe(bug);
    expect(pendingSignal.aborted).toBe(false);
    staleAbort();
    expect(pendingSignal.aborted).toBe(false);
    await expect(observed.promise).resolves.toBe(bug);
    await expect(request.done).rejects.toBe(bug);
    const holding = events.filter(event => event.type === 'stage.entered')
      .find(event => event.name === 'holding-owner' && event.facts['request.mode'] === 'hold');
    const reached = events.find(event => event.type === 'stage.panicked' && event.stageId === holding?.stageId);
    expect(reached).toEqual({ type: 'stage.panicked', stageId: holding?.stageId, error: bug });
    expect(pendingSignal.aborted).toBe(false);
    staleAbort();
    expect(pendingSignal.aborted).toBe(false);
    host.abort('host saw the panic');
    expect(pendingSignal.reason).toBe('host saw the panic');
    await ioStopped.promise;
  });

  it('detaches a forwarded child immediately at native done even while the parent remains live', async () => {
    const host = new AbortController();
    const signals: AbortSignal[] = [];
    const ending = defineStage({
      name: 'exhaustion-target',
      request: { needs: [] },
      return: { provides: ['response.stream'] },
      execute: async (_facts, scope) => {
        signals.push(scope.signal);
        return {
          'response.stream': scope.createStream<string, string>(async function* () { yield success('complete'); }),
        };
      },
    });
    const middle = defineStage({
      name: 'forwards-exhausted',
      through: { request: untouched, response: streamResponse },
      execute: async (facts, scope) => {
        signals.push(scope.signal);
        return await scope.next(facts);
      },
    });
    const parent = defineStage({
      name: 'producer-parent',
      through: { request: untouched, response: { ...streamResponse, provides: ['response.stream'] } },
      execute: async (facts, scope) => {
        const answer = await scope.next(facts);
        return {
          ...answer,
          'response.stream': scope.wrapStream<string, string, string, string>(answer['response.stream'], async function* (source, producer) {
            yield* source;
            producer.abort(answer);
            host.abort();
            expect(producer.signal.aborted).toBe(true);
            expect(signals.map(signal => signal.aborted)).toEqual([false, false]);
          }),
        };
      },
    });
    const pipeline = compose('detach-on-native-done', {
      entry: [], exit: ['response.stream'], stages: [parent, middle], ending,
    });
    const request = run(pipeline, {}, { services: {}, signal: host.signal });
    const iterator = (await request.result)['response.stream'][Symbol.asyncIterator]();
    await expect(iterator.next()).resolves.toEqual({ done: false, value: success('complete') });
    await expect(iterator.next()).resolves.toEqual({ done: true, value: undefined });
    await request.done;
  });

  it.each(['parent', 'promise', 'answer'] as const)('follows abort by %s through a forwarded answer until native done', async key => {
    const host = new AbortController();
    const draining = Promise.withResolvers<void>();
    let terminalSignal!: AbortSignal;
    let middleSignal!: AbortSignal;
    const ending = defineStage({
      name: 'aborted-terminal',
      request: { needs: [] },
      return: { provides: ['response.stream'] },
      execute: async (_facts, scope) => {
        terminalSignal = scope.signal;
        return {
          'response.stream': scope.createStream<string, string>(async function* (producer) {
            yield success('started');
            expect(producer.signal).toBe(terminalSignal);
            expect(producer.signal.aborted).toBe(true);
            yield failure('abort');
            await draining.promise;
          }),
        };
      },
    });
    const middle = defineStage({
      name: 'forwards',
      through: { request: untouched, response: streamResponse },
      execute: async (facts, scope) => {
        middleSignal = scope.signal;
        return await scope.next(facts);
      },
    });
    const parent = defineStage({
      name: 'aborting-owner',
      through: { request: untouched, response: { ...streamResponse, provides: ['response.stream'] } },
      execute: async (facts, scope) => {
        const call = scope.next(facts);
        const answer = await call;
        const stream = scope.wrapStream<string, string, string, string>(answer['response.stream'], async function* (inner, producer) {
          for await (const item of inner) {
            if (item.ok) {
              expect(middleSignal.aborted).toBe(false);
              expect(terminalSignal.aborted).toBe(false);
              if (key === 'parent') host.abort('host');
              else producer.abort(key === 'promise' ? call : answer);
              expect(middleSignal.aborted).toBe(true);
              expect(terminalSignal.aborted).toBe(true);
            }
            yield item;
          }
          producer.abort(call);
        });
        return { ...answer, 'response.stream': stream };
      },
    });
    const pipeline = compose('abort-downstream', {
      entry: [], exit: ['response.stream'], stages: [parent, middle], ending,
    });
    const request = run(pipeline, {}, { services: {}, signal: host.signal });
    const iterator = (await request.result)['response.stream'][Symbol.asyncIterator]();
    await expect(iterator.next()).resolves.toEqual({ done: false, value: success('started') });
    await expect(iterator.next()).resolves.toEqual({ done: false, value: failure('abort') });
    const nativeDone = iterator.next();
    draining.resolve();
    await expect(nativeDone).resolves.toEqual({ done: true, value: undefined });
    await request.done;
  });

  it('treats a throw after abort as a panic', async () => {
    const host = new AbortController();
    const bug = new Error('abort cleanup bug');
    const ending = defineStage({
      name: 'abort-bug',
      request: { needs: [] },
      return: { provides: ['response.stream'] },
      execute: async (_facts, scope) => ({
        'response.stream': scope.createStream<string, string>(async function* (producer) {
          yield success('ready');
          expect(producer.signal.aborted).toBe(true);
          throw bug;
        }),
      }),
    });
    const pipeline = compose('after-abort', { entry: [], exit: ['response.stream'], stages: [], ending });
    const request = run(pipeline, {}, { services: {}, signal: host.signal });
    const iterator = (await request.result)['response.stream'][Symbol.asyncIterator]();
    await iterator.next();
    host.abort();
    await expect(iterator.next()).rejects.toBe(bug);
    await expect(request.done).rejects.toBe(bug);
  });

  it('joins a request-stream producer through its final post-abort drain', async () => {
    const drained = Promise.withResolvers<void>();
    const consumer = defineStage({
      name: 'request-consumer',
      request: { needs: ['request.stream'] },
      return: { provides: ['response.value'] },
      execute: async facts => {
        const source = facts['request.stream'];
        const frames: Frame[] = [];
        for await (const frame of source) frames.push(frame);
        expect(frames).toEqual([failure('request aborted')]);
        return { 'response.value': 'joined' };
      },
    });
    const parent = defineStage({
      name: 'request-producer',
      through: { request: { ...untouched, provides: ['request.stream'] }, response: valueResponse },
      execute: async (facts, scope) => await scope.next({
        ...facts,
        'request.stream': scope.createStream<string, string>(async function* (producer) {
          expect(producer.signal.aborted).toBe(true);
          yield failure('request aborted');
          await drained.promise;
        }),
      }),
    });
    const pipeline = compose('request-drain', {
      entry: [], exit: ['response.value'], stages: [parent], ending: consumer,
    });
    const host = new AbortController();
    host.abort();
    const request = run(pipeline, move({}), { services: {}, signal: host.signal });
    drained.resolve();
    await expect(request.result).resolves.toEqual({ 'response.value': 'joined' });
    await request.done;
  });
});
