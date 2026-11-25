import { describe, expect, it } from 'vitest';

import { aborted, host } from './run-fixture.ts';
import { factSpace, run } from '../src/index.ts';
import type { ManagedStream } from '../src/index.ts';

const none = { needs: [], provides: [], consumes: [] } as const;

describe('child calls', () => {
  it('aborts only the original promise, once, including while its answered stream is live', async () => {
    const { defineStage, compose } = factSpace<{
      'request.child': number;
      'response.body': ManagedStream<number, string>;
      'response.status': number;
    }>();
    const signals = new Map<number, AbortSignal>();
    let abortEvents = 0;
    const sub = defineStage({
      name: 'sub',
      request: { needs: ['request.child'] },
      return: { provides: ['response.body'] },
      execute: async (facts, scope) => {
        const index = facts['request.child'];
        signals.set(index, scope.signal);
        scope.signal.addEventListener('abort', () => { abortEvents += 1; });
        return {
          'response.body': scope.createStream<number, string>(async function* ({ signal }) {
            if (index === 1) {
              await aborted(signal);
              yield { ok: false, error: 'aborted first' };
            } else {
              yield { ok: true, value: index };
            }
          }),
        };
      },
    });
    const child = compose('sub', { entry: ['request.child'], exit: ['response.body'], stages: [], ending: sub });
    const ending = defineStage({
      name: 'host-child',
      request: none,
      return: { provides: ['response.status'] },
      execute: async (_facts, scope) => {
        const first = scope.run(child, { 'request.child': 1 });
        const second = scope.run(child, { 'request.child': 2 });
        expect(first).not.toBe(second);
        const [one, two] = await Promise.all([first, second]);
        expect(() => scope.abort(first.then(value => value))).toThrow('original promise');
        expect(signals.get(1)).not.toBe(signals.get(2));
        scope.abort(first);
        scope.abort(first);
        expect(signals.get(1)?.aborted).toBe(true);
        expect(signals.get(2)?.aborted).toBe(false);
        scope.discard(one['response.body']);
        await expect(Array.fromAsync(scope.read(two['response.body']))).resolves.toEqual([{ ok: true, value: 2 }]);
        scope.abort(second);
        expect(signals.get(2)?.aborted).toBe(false);
        return { 'response.status': 200 };
      },
    });
    const pipeline = compose('host-child', { entry: [], exit: ['response.status'], stages: [], ending });
    const recording = host({});
    const running = run(pipeline, {}, recording.options);
    await expect(running.result).resolves.toEqual({ 'response.status': 200 });
    await recording.rootLeft;
    expect(abortEvents).toBe(1);
  });

  it('detaches a settled child signal while an active child follows host cancellation', async () => {
    const { defineStage, compose } = factSpace<{ 'request.slow': boolean; 'response.status': number }>();
    const sources = new Map<boolean, AbortSignal>();
    const started = Promise.withResolvers<void>();
    const child = defineStage({
      name: 'child',
      request: { needs: ['request.slow'] },
      return: { provides: ['response.status'] },
      execute: async ({ 'request.slow': slow }, { signal }) => {
        sources.set(slow, signal);
        if (slow) {
          started.resolve();
          await aborted(signal);
        }
        return { 'response.status': 200 };
      },
    });
    const sub = compose('child', { entry: ['request.slow'], exit: ['response.status'], stages: [], ending: child });
    const ending = defineStage({
      name: 'start-children',
      request: none,
      return: { provides: ['response.status'] },
      execute: async (_facts, scope) => {
        const settled = scope.run(sub, { 'request.slow': false });
        await settled;
        scope.abort(settled);
        return await scope.run(sub, { 'request.slow': true });
      },
    });
    const pipeline = compose('parent', { entry: [], exit: ['response.status'], stages: [], ending });
    const recording = host({});
    const running = run(pipeline, {}, recording.options);
    await started.promise;
    const reason = new Error('host cancelled');
    recording.controller.abort(reason);
    await running.done;
    expect(sources.get(true)?.reason).toBe(reason);
    expect(sources.get(false)?.aborted).toBe(false);
  });

  it('rejects a foreign promise as a stage panic', async () => {
    const { defineStage, compose } = factSpace<{}>();
    const ending = defineStage({
      name: 'bad-abort-key',
      request: none,
      return: { provides: [] },
      execute: async (_facts, scope) => {
        scope.abort(Promise.resolve({}));
        return {};
      },
    });
    const pipeline = compose('bad-abort-key', { entry: [], exit: [], stages: [], ending });
    const running = run(pipeline, {}, host({}).options);
    await expect(running.result).rejects.toThrow('from this executor');
  });

  it('does not turn a bug thrown after cancellation into an ordinary outcome', async () => {
    const { defineStage, compose } = factSpace<{}>();
    const bug = new Error('assertion after abort');
    const ending = defineStage({
      name: 'cancelled',
      request: none,
      return: { provides: [] },
      execute: async (_facts, { signal }) => {
        await aborted(signal);
        throw bug;
      },
    });
    const pipeline = compose('cancelled', { entry: [], exit: [], stages: [], ending });
    const recording = host({});
    const running = run(pipeline, {}, recording.options);
    recording.controller.abort();
    await expect(running.result).rejects.toBe(bug);
    await expect(running.done).rejects.toBe(bug);
  });
});
