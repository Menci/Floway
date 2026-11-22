import { describe, expect, it } from 'vitest';

import { compose, DeclarationViolationError, defineEnding, defineStage, link, run } from '../src/index.ts';
import type { DynamicTarget, IntoMap, Pipeline, StaticTarget } from '../src/index.ts';

const options = { services: {}, finalizationTimeoutMs: 100 };
const empty = { needs: [], consumes: [], provides: [] };
const terminal = defineEnding<{ input: number }, { result: string }>({
  name: 'leaf', request: { needs: ['input'] }, response: { provides: ['result'] },
  execute: async ({ input }) => ({ result: String(input) }),
});

describe('composition', () => {
  it('derives the entry and exit across edits and synthetic answers', () => {
    const stage = defineStage<{ seed: number }, { input: number }, { result: string }, { outer: string }>({
      name: 'format',
      through: {
        request: { needs: ['seed'], consumes: ['seed'], provides: ['input'] },
        response: { needs: ['result'], consumes: ['result'], provides: ['outer'] },
      },
      return: { provides: ['outer', 'optional'] },
      execute: async ({ seed, ...rest }, next) => {
        const { result, ...back } = await next({ ...rest, input: seed });
        return { ...back, outer: result };
      },
    });
    const pipeline = compose<{ seed: number }, { outer: string }, {}>('format', { stages: [stage], ending: terminal });
    expect(pipeline.entry).toEqual(['seed']);
    expect(pipeline.exit).toEqual(['outer']);
    expect(Object.isFrozen(pipeline.entry)).toBe(true);
  });

  it('rejects a later need for a consumed key, response needs missing on a synthetic branch, and duplicate names', () => {
    const consume = defineStage({
      name: 'consume', through: { request: { ...empty, consumes: ['input'] }, response: empty },
      execute: async (facts, next) => await next(facts),
    });
    expect(() => compose('consumed', { stages: [consume], ending: terminal })).toThrow('consumed by an earlier stage');

    const outer = defineStage({
      name: 'outer', through: { request: empty, response: { ...empty, needs: ['result'] } },
      execute: async (facts, next) => await next(facts),
    });
    const synthetic = defineStage({
      name: 'only-answer', return: { provides: ['different'] },
      execute: async () => ({ different: 17 }),
    });
    expect(() => compose('uncovered', { stages: [outer, synthetic], ending: terminal })).toThrow('no child guarantees "result"');
    expect(() => compose('duplicate', { stages: [outer, outer], ending: terminal })).toThrow('Duplicate stage');
  });

  it('links TDZ-safe mutual recursion and resolves each static thunk once', async () => {
    type Input = { input: number };
    type Output = { result: string };
    type Target = { other: StaticTarget<Input, Output, {}> };
    const ending = defineEnding<Input, Output, Target>({
      name: 'recur', request: { needs: ['input'] }, response: { provides: ['result'] },
      execute: async (facts, into) => facts.input > 0 ? await into.other({ input: facts.input - 1 }) : ({ result: 'done' }),
    });
    let resolutions = 0;
    const a: Pipeline<Input, Output, {}> = compose<Input, Output, {}, Target>('a', {
      stages: [], ending, targets: { other: () => { resolutions++; return b; } },
    });
    const b: Pipeline<Input, Output, {}> = compose<Input, Output, {}, Target>('b', {
      stages: [], ending, targets: { other: () => { resolutions++; return a; } },
    });
    expect(resolutions).toBe(0);
    await expect(run(a, { input: 2 }, options).result).rejects.toThrow('unlinked targets');
    link([a]);
    link([b, a]);
    expect(resolutions).toBe(2);
    await expect(run(a, { input: 2 }, options).result).resolves.toEqual({ result: 'done' });
    expect(resolutions).toBe(2);
  });

  it('checks dynamic entry and exit keys against a copied contract and verifies actual input', async () => {
    type Input = { input: number };
    type Output = { result: string };
    type Targets = { slot: DynamicTarget<'selected', Input, Output, {}> };
    const leaf = compose<Input, Output, {}>('leaf', { stages: [], ending: terminal });
    const entry = ['input'];
    const exit = ['result'];
    let selections = 0;
    const ending = defineEnding<{ input: number; omit?: boolean }, Output, Targets>({
      name: 'forward', request: { needs: ['input'] }, response: { provides: ['result'] },
      execute: async (facts, into) => {
        if (facts.omit) return await into.slot('selected', {} as Input);
        return await into.slot('selected', facts);
      },
    });
    const targets: Targets = { slot: { entry, exit, resolve: () => { selections++; return leaf; } } };
    const pipeline = compose<{ input: number; omit?: boolean }, Output, {}, Targets>('dynamic', { stages: [], targets, ending });
    const invalidEntry = compose<Input, Output, {}, Targets>('invalid-entry', {
      stages: [], ending, targets: { slot: { entry: [], exit, resolve: () => leaf } },
    });
    const invalidExit = compose<Input, Output, {}, Targets>('invalid-exit', {
      stages: [], ending, targets: { slot: { entry, exit: ['other'], resolve: () => leaf } },
    });
    entry.length = 0;
    exit.push('other');
    link([pipeline, invalidEntry, invalidExit]);
    expect(selections).toBe(0);
    await expect(run(pipeline, { input: 4 }, options).result).resolves.toEqual({ result: '4' });
    await expect(run(pipeline, { input: 4, omit: true }, options).result).rejects.toThrow(DeclarationViolationError);
    await expect(run(invalidEntry, { input: 4 }, options).result).rejects.toThrow('unregistered "input"');
    await expect(run(invalidExit, { input: 4 }, options).result).rejects.toThrow('does not guarantee "other"');
    expect(selections).toBe(2);
  });

  it('exposes only declared into inputs and responses and omits next on return-only stages', () => {
    type I = { input: number };
    type O = { result: string };
    type Targets = {
      thunk: () => Pipeline<I, O, {}>;
      slot: DynamicTarget<'selected', I, O, {}>;
    };
    const check = async (into: IntoMap<Targets>) => {
      const { result } = await into.thunk({ input: 1 });
      const back = await into.slot('selected', { input: 2 });
      // @ts-expect-error Unknown target.
      await into.unregistered({ input: 1 });
      // @ts-expect-error Wrong input type.
      await into.thunk({ input: '1' });
      // @ts-expect-error Wrong dynamic key.
      await into.slot(1, { input: 2 });
      // @ts-expect-error Unknown response field.
      back.other;
      return result.concat(back.result);
    };
    const stage = defineStage<I, O>({
      name: 'answer', return: { provides: ['result'] },
      execute: async (facts, env) => {
        // @ts-expect-error A return-only stage receives the environment in the second position.
        env(facts);
        return { result: String(facts.input) };
      },
    });
    const ending = defineEnding<I, O, Targets>({
      name: 'forward', request: { needs: ['input'] }, response: { provides: ['result'] },
      execute: async (facts, into) => await into.thunk(facts),
    });
    const leaf = compose<I, O, {}>('leaf', { stages: [], ending: terminal });
    const invalid = () => {
      // @ts-expect-error The fourth argument must match the ending's target map.
      compose<I, O, {}>('untyped target', { stages: [], targets: { thunk: () => leaf }, ending });
      // @ts-expect-error The dynamic slot is required by Targets.
      compose<I, O, {}, Targets>('missing slot', { stages: [], targets: { thunk: () => leaf }, ending });
      // @ts-expect-error A terminal cannot serve as this target-aware ending.
      compose<I, O, {}, Targets>('wrong ending', { stages: [], targets: { thunk: () => leaf, slot: { entry: [], exit: [], resolve: () => leaf } }, ending: terminal });
    };
    expect([check, stage, invalid]).toHaveLength(3);
  });
});
