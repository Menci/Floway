import { describe, expect, it } from 'vitest';

import { compose, DeclarationViolationError, defineEnding, defineStage, FinalizationTimeoutError, run, transform, UnsettledDeferredError } from '../src/index.ts';
import type { Deferred, Facts, RunEvent, SideDecl } from '../src/index.ts';

const options = { services: {}, finalizationTimeoutMs: 200 };
const identity = { needs: [], consumes: [], provides: [] };

const leaf = defineEnding<Facts, Facts>({
  name: 'leaf', request: { needs: ['branch'] }, response: { provides: ['response', 'preserve'] },
  execute: async facts => ({ response: facts.branch, preserve: { branch: facts.branch } }),
});

describe('declarations during execution', () => {
  const examples: Array<[string, SideDecl, (facts: Facts) => Facts, string]> = [
    ['branch stays with undefined', { ...identity, consumes: ['drop'] }, facts => ({ ...facts, drop: undefined }), 'declared consuming "drop"'],
    ['provided key is absent', { ...identity, provides: ['added'] }, facts => facts, 'declared providing "added"'],
    ['undeclared key changes', identity, facts => ({ ...facts, branch: 3 }), 'changed or removed undeclared "branch"'],
    ['undeclared key appears', identity, facts => ({ ...facts, added: 3 }), 'added undeclared "added"'],
  ];

  it.each(examples)('rejects a down handover where %s', async (_title, request, update, message) => {
    const stage = defineStage<Facts, Facts, Facts, Facts>({
      name: 'down', through: { request, response: identity },
      execute: async (facts, next) => await next(update(facts)),
    });
    const pipeline = compose('checks', { stages: [stage], ending: leaf });
    const handle = run(pipeline, { branch: 1, drop: true }, options);
    await expect(handle.result).rejects.toMatchObject({ name: 'DeclarationViolationError', direction: 'down', detail: expect.stringContaining(message) });
    await expect(handle.done).resolves.toMatchObject({ ok: false });
  });

  it.each(examples.map(([title, side, change, message]) => [title, {
    ...side, consumes: side.consumes.map(() => 'response'),
  }, change, message.replace('"drop"', '"response"').replace('"branch"', '"preserve"')] as const))(
    'rejects an up handover where %s', async (_title, response, change, message) => {
      const stage = defineStage<Facts, Facts, Facts, Facts>({
        name: 'up', through: { request: identity, response },
        execute: async (facts, next) => {
          const back = await next(facts);
          if (response.consumes.length) return { ...back, response: undefined };
          if (message.includes('"preserve"')) return { ...back, preserve: {} };
          return change(back);
        },
      });
      const pipeline = compose('checks', { stages: [stage], ending: leaf });
      const handle = run(pipeline, { branch: 1 }, options);
      await expect(handle.result).rejects.toMatchObject({ name: 'DeclarationViolationError', direction: 'up', detail: expect.stringContaining(message) });
    },
  );

  it('uses the earlier winning child as the base and leaves retained keys untouched', async () => {
    const stage = defineStage<Facts, Facts, Facts, Facts>({
      name: 'choose', through: {
        request: { ...identity, provides: ['branch'] },
        response: { ...identity, consumes: ['response'], provides: ['winner'] },
      },
      execute: async (facts, next) => {
        const first = await next({ ...facts, branch: 1 });
        await next({ ...facts, branch: 2 });
        const { response, ...rest } = first;
        return { ...rest, winner: response };
      },
    });
    const events: RunEvent[] = [];
    const pipeline = compose<Facts, Facts, {}>('fork', { stages: [stage], ending: leaf });
    const handle = run(pipeline, {}, { ...options, events: event => events.push(event) });
    const output = await handle.result;
    await expect(handle.done).resolves.toEqual({ ok: true });
    const children = events.filter(event => event.k === 'enter' && event.edge === 'next');
    expect(children).toHaveLength(2);
    expect(events).toContainEqual(expect.objectContaining({ k: 'leave', stageId: 1, facts: output, baseChildId: 2 }));
    expect(output).toEqual({ preserve: { branch: 1 }, winner: 1 });
  });

  it('accepts a declared synthetic response and counts present undefined for needs and provides', async () => {
    const stage = defineStage<Facts, Facts, Facts, Facts>({
      name: 'stub',
      through: { request: identity, response: identity },
      return: { provides: ['response'] },
      execute: async (facts, next) => {
        await next(facts);
        return { response: undefined };
      },
    });
    const pipeline = compose('synthetic', { stages: [stage], ending: leaf });
    await expect(run(pipeline, { branch: undefined }, options).result).resolves.toStrictEqual({ response: undefined });
    await expect(run(pipeline, {}, options).result).rejects.toThrow(DeclarationViolationError);

    const missing = defineStage({
      name: 'missing', return: { provides: ['response'] }, execute: async () => ({}),
    });
    await expect(run(compose('missing', { stages: [missing], ending: leaf }), { branch: 1 }, options).result).rejects.toThrow('missing "response"');

    const absent = defineStage({
      name: 'absent', through: { request: identity, response: identity }, execute: async () => ({}),
    });
    await expect(run(compose('absent', { stages: [absent], ending: leaf }), { branch: 1 }, options).result).rejects.toThrow('without a child response');
  });

  it('runs transform open per invocation and passes through an omitted side by identity', async () => {
    const inputs: Facts[] = [];
    const stage = defineStage<Facts, Facts, Facts, Facts>({
      name: 'rewrite', through: { request: identity, response: { ...identity, provides: ['response'] } },
      execute: transform(() => {
        let count = 0;
        return { response: back => ({ ...back, response: ++count }) };
      }),
    });
    const terminal = defineEnding<Facts, Facts>({
      name: 'identity', request: { needs: [] }, response: { provides: [] },
      execute: async facts => { inputs.push(facts); return facts; },
    });
    const pipeline = compose<Facts, Facts, {}>('rewrite', { stages: [stage], ending: terminal });
    const input = { branch: 1 };
    await expect(run(pipeline, input, options).result).resolves.toEqual({ branch: 1, response: 1 });
    await expect(run(pipeline, input, options).result).resolves.toEqual({ branch: 1, response: 1 });
    expect(inputs[0]).toBe(input);
    expect(inputs[1]).toBe(input);
  });
});

describe('run completion', () => {
  it('joins a deferred admitted before a throw and keeps the original failure and input facts', async () => {
    const events: RunEvent[] = [];
    const work = Promise.withResolvers<Facts>();
    const boom = new Error('transport failed', { cause: new Error('socket') });
    const end = defineEnding<Facts, Facts>({
      name: 'thrower', request: { needs: [] }, response: { provides: [] },
      execute: async (facts, _into, env) => {
        env.log.info('starting', facts);
        env.defer('measurement', work.promise);
        throw boom;
      },
    });
    const pipeline = compose('run', { stages: [], ending: end });
    const input = { detail: { at: 'terminal' } };
    const handle = run(pipeline, input, { ...options, events: event => events.push(event) });
    await expect(handle.result).rejects.toBe(boom);
    expect(events.map(event => event.k)).toEqual(['run', 'enter', 'log', 'deferred', 'fail', 'closed']);
    expect(events.find(event => event.k === 'fail')).toMatchObject({ facts: input, error: { message: 'transport failed', cause: { message: 'socket' } } });
    expect(Object.isFrozen(boom)).toBe(false);
    const value = { duration: { value: 17 } };
    work.resolve(value);
    await expect(handle.done).resolves.toMatchObject({ ok: false, error: { message: 'transport failed' } });
    expect(Object.isFrozen(value.duration)).toBe(true);
    expect(events.find(event => event.k === 'settled')).toMatchObject({ ok: true, value });
    expect(events.map(event => event.seq)).toEqual(events.map((_, index) => index + 1));
  });

  it('rejects unsettled scope and stream deferreds and rejects a second manual settlement', async () => {
    const end = defineEnding<{}, { scope: Deferred<number>; body: Deferred<number>; result: Deferred<number> }>({
      name: 'unsettled', request: { needs: [] }, response: { provides: ['scope', 'body', 'result'] },
      execute: async (_facts, _into, env) => {
        const owner = env.createStream({ label: 'body', async *iterate() { yield 1; } });
        const body = env.deferred<number>('body measurement', owner);
        const scope = env.deferred<number>('scope measurement', 'scope');
        const settled = env.deferred<number>('manual', 'scope');
        settled.resolve(3);
        expect(() => settled.resolve(4)).toThrow('already settled');
        await owner.close();
        return { scope: scope.deferred, body: body.deferred, result: settled.deferred };
      },
    });
    type Result = { scope: Deferred<number>; body: Deferred<number>; result: Deferred<number> };
    const handle = run(compose<{}, Result, {}>('unsettled', { stages: [], ending: end }), {}, options);
    const facts = await handle.result;
    await expect(facts.scope.promise).rejects.toBeInstanceOf(UnsettledDeferredError);
    await expect(facts.body.promise).rejects.toBeInstanceOf(UnsettledDeferredError);
    await expect(facts.result.promise).resolves.toBe(3);
    await expect(handle.done).resolves.toMatchObject({ ok: false, error: { name: 'AggregateError' } });
  });

  it('rejects pending work at the finalization deadline', async () => {
    const end = defineEnding<{}, { never: Deferred<unknown> }>({
      name: 'unsettled', request: { needs: [] }, response: { provides: ['never'] },
      execute: async (_facts, _into, env) => ({ never: env.defer('pending', Promise.withResolvers().promise) }),
    });
    const handle = run(compose<{}, { never: Deferred<unknown> }, {}>('timeout', { stages: [], ending: end }), {}, {
      ...options, finalizationTimeoutMs: 15,
    });
    const result = await handle.result;
    await expect(result.never.promise).rejects.toBeInstanceOf(FinalizationTimeoutError);
    await expect(handle.done).resolves.toMatchObject({ ok: false, error: { name: 'FinalizationTimeoutError' } });
  });

  it('joins sub-run completion and isolates a throwing event sink', async () => {
    const work = Promise.withResolvers<number>();
    const order: string[] = [];
    const events: RunEvent[] = [];
    const child = compose<{}, { response: number }, {}>('child', {
      stages: [], ending: defineEnding({
        name: 'background', request: { needs: [] }, response: { provides: ['response'] },
        execute: async (_facts, _into, env) => {
          env.defer('child work', work.promise);
          return { response: 1 };
        },
      }),
    });
    const pipeline = compose<{}, { response: number }, {}>('parent', {
      stages: [], ending: defineEnding({
        name: 'parent', request: { needs: [] }, response: { provides: ['response'] },
        execute: async (_facts, _into, env) => {
          const sub = env.run(child, {});
          void sub.done.then(() => order.push('child'));
          return await sub.result;
        },
      }),
    });
    const handle = run(pipeline, {}, {
      ...options, events: event => {
        events.push(event);
        if (event.k === 'enter') throw new Error('sink');
      },
    });
    await expect(handle.result).resolves.toEqual({ response: 1 });
    expect(events.some(event => event.k === 'done')).toBe(false);
    work.resolve(2);
    await expect(handle.done).resolves.toEqual({ ok: true });
    expect(order).toEqual(['child']);
    expect(events).toContainEqual(expect.objectContaining({ k: 'enter', pipeline: 'child', edge: 'subrun', parentStageId: 1 }));
    expect(events.filter(event => event.k === 'done')).toHaveLength(1);
  });
});
