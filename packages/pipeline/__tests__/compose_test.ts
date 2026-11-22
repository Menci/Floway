import { describe, expect, it } from 'vitest';

import { compose, DeclarationViolationError, defineEnding, defineStage, link, run } from '../src/index.ts';
import type { DynamicTarget, IntoMap, Pipeline, StaticTarget } from '../src/index.ts';

const options = { services: {}, finalizationTimeoutMs: 100 };
const empty = { needs: [], consumes: [], provides: [] };
const passthrough = { request: empty, response: { ...empty, needs: ['result'] } };
const terminal = defineEnding<{ input: number }, { result: string }>({
  name: 'leaf', request: { needs: ['input'] }, return: { provides: ['result'] },
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
      name: 'recur', request: { needs: ['input'] }, return: { provides: ['result'] },
      into: { other: { ...passthrough, request: { ...empty, provides: ['input'] } } },
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
    const ending = defineEnding<{ input?: number }, Output, Targets>({
      name: 'forward', request: { needs: [] }, into: { slot: passthrough },
      execute: async (facts, into) => await into.slot('selected', facts as Input),
    });
    const targets: Targets = { slot: { entry, exit, resolve: () => { selections++; return leaf; } } };
    const pipeline = compose<{ input?: number }, Output, {}, Targets>('dynamic', { stages: [], targets, ending });
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
    await expect(run(pipeline, {}, options).result).rejects.toMatchObject({ name: 'DeclarationViolationError', direction: 'entry' });
    await expect(run(invalidEntry, { input: 4 }, options).result).rejects.toThrow('unregistered "input"');
    await expect(run(invalidExit, { input: 4 }, options).result).rejects.toThrow('does not guarantee "other"');
    expect(selections).toBe(2);
  });

  it('derives slot exit keys and checks declared translations in both directions', async () => {
    type Input = { input: number };
    type Output = { result: string };
    type Source = { source: string };
    type Translated = { output: string };
    type Target = { leaf: StaticTarget<Input, Output, {}> };
    const leaf = compose<Input, Output, {}>('leaf', { stages: [], ending: terminal });
    const declarations = {
      leaf: {
        request: { needs: ['source'], consumes: ['source'], provides: ['input'] },
        response: { needs: ['result'], consumes: ['result'], provides: ['output'] },
      },
    };
    const ending = defineEnding<Source, Translated, Target>({
      name: 'translate', request: { needs: ['source'] }, into: declarations, return: { provides: ['output', 'optional'] },
      execute: async ({ source, ...rest }, into) => {
        if (source === 'stub') return { output: 'stub', optional: true };
        const request = { ...rest, input: Number(source), ...(source === 'bad request' ? { extra: 1 } : {}) };
        const { result, ...back } = await into.leaf(request);
        return { ...back, output: result, ...(source === 'bad response' ? { result } : {}) };
      },
    });
    const targets = { leaf };
    const pipeline = compose<Source, Translated, {}, Target>('translate', { stages: [], ending, targets });
    expect(pipeline.entry).toEqual(['source']);
    expect(pipeline.exit).toEqual(['output']);
    link([pipeline]);
    await expect(run(pipeline, { source: '4' }, options).result).resolves.toEqual({ output: '4' });
    await expect(run(pipeline, { source: 'stub' }, options).result).resolves.toEqual({ output: 'stub', optional: true });
    await expect(run(pipeline, { source: 'bad request' }, options).result).rejects.toThrow('added undeclared "extra"');
    await expect(run(pipeline, { source: 'bad response' }, options).result).rejects.toThrow('declared consuming "result"');

    const extra = { ...targets, smuggled: leaf };
    expect(() => compose<Source, Translated, {}, Target>('extra', { stages: [], ending, targets: extra })).toThrow('undeclared target "smuggled"');
  });

  it('checks a static target response guarantee after resolving its thunk', () => {
    type Input = { input: number };
    type Output = { result: string };
    type Target = { leaf: StaticTarget<Input, Output, {}> };
    const ending = defineEnding<Input, Output, Target>({
      name: 'forward', request: { needs: [] }, into: { leaf: { request: empty, response: { ...empty, needs: ['missing'] } } },
      execute: async (facts, into) => await into.leaf(facts),
    });
    const target = compose<Input, Output, {}>('leaf', { stages: [], ending: terminal });
    const p = compose<Input, Output, {}, Target>('forward', { stages: [], ending, targets: { leaf: () => target } });
    expect(() => link([p])).toThrow(DeclarationViolationError);
    expect(() => link([p])).toThrow('does not guarantee "missing"');
  });

  it('rejects a missing response need before an into call resumes its ending', async () => {
    type Target = { child: DynamicTarget<'selected', {}, {}, {}> };
    const child = compose<{}, {}, {}>('child', {
      stages: [], ending: defineEnding({
        name: 'child', request: { needs: [] }, return: { provides: [] }, execute: async () => ({}),
      }),
    });
    let resumed = false;
    const ending = defineEnding<{}, {}, Target>({
      name: 'parent', request: { needs: [] }, into: { child: { request: empty, response: { ...empty, needs: ['missed'] } } },
      execute: async (facts, into) => {
        const result = await into.child('selected', facts);
        resumed = true;
        return result;
      },
    });
    const pipeline = compose<{}, {}, {}, Target>('parent', {
      stages: [], ending, targets: { child: { entry: [], exit: [], resolve: () => child } },
    });
    link([pipeline]);
    const handle = run(pipeline, {}, options);
    await expect(handle.result).rejects.toMatchObject({ name: 'DeclarationViolationError', direction: 'up', detail: 'missing "missed"' });
    expect(resumed).toBe(false);
  });

  it('requires only the selected ending slot’s request needs', async () => {
    type Input = { route: 'a' | 'b'; a?: number; b?: number };
    type Output = { result: string };
    type Targets = { a: StaticTarget<Input, Output, {}>; b: StaticTarget<Input, Output, {}> };
    const leaf = compose<Input, Output, {}>('leaf', {
      stages: [], ending: defineEnding<Input, Output>({
        name: 'leaf', request: { needs: ['route'] }, return: { provides: ['result'] },
        execute: async facts => ({ result: String(facts[facts.route]) }),
      }),
    });
    const router = compose<Input, Output, {}, Targets>('router', {
      stages: [], targets: { a: leaf, b: leaf },
      ending: defineEnding<Input, Output, Targets>({
        name: 'route', request: { needs: ['route'] },
        into: {
          a: { ...passthrough, request: { ...empty, needs: ['a'] } },
          b: { ...passthrough, request: { ...empty, needs: ['b'] } },
        },
        execute: async (facts, into) => await into[facts.route](facts),
      }),
    });
    link([router]);
    await expect(run(router, { route: 'a', a: 12 }, options).result).resolves.toEqual({ result: '12' });
    await expect(run(router, { route: 'b', a: 12 }, options).result).rejects.toThrow('missing "b"');
    expect(router.entry).toEqual(['route']);
  });

  it('requires the composing service slice to cover all static and dynamic targets', async () => {
    type Ports = { price: () => number };
    type Services = Ports & { currency: string };
    type Output = { result: string };
    type Targets = { static: StaticTarget<{}, Output, Ports>; dynamic: DynamicTarget<'standard', {}, Output, Ports> };
    const target = compose<{}, Output, Ports>('target', {
      stages: [], ending: defineEnding<{}, Output, {}, Ports>({
        name: 'price', request: { needs: [] }, return: { provides: ['result'] },
        execute: async (_facts, _into, env) => ({ result: String(env.services.price()) }),
      }),
    });
    const targets: Targets = { static: () => target, dynamic: { entry: [], exit: ['result'], resolve: () => target } };
    const missingPorts = () => {
      const staticEnding = defineEnding<{}, Output, Pick<Targets, 'static'>>({
        name: 'static', request: { needs: [] }, into: { static: passthrough }, execute: async (facts, into) => await into.static(facts),
      });
      const dynamicEnding = defineEnding<{}, Output, Pick<Targets, 'dynamic'>>({
        name: 'dynamic', request: { needs: [] }, into: { dynamic: passthrough }, execute: async (facts, into) => await into.dynamic('standard', facts),
      });
      // @ts-expect-error The thunk's target requires the price port.
      compose<{}, Output, {}, Pick<Targets, 'static'>>('invalid static', { stages: [], ending: staticEnding, targets });
      // @ts-expect-error The dynamic slot requires the price port.
      compose<{}, Output, {}, Pick<Targets, 'dynamic'>>('invalid dynamic', { stages: [], ending: dynamicEnding, targets });
    };
    expect(typeof missingPorts).toBe('function');
    const pipeline = compose<{}, Output, Services, Targets>('valid', {
      stages: [], targets,
      ending: defineEnding<{}, Output, Targets, Services>({
        name: 'route', request: { needs: [] }, into: { static: passthrough, dynamic: passthrough },
        execute: async (facts, into) => await into.dynamic('standard', facts),
      }),
    });
    link([pipeline]);
    await expect(run(pipeline, {}, { ...options, services: { price: () => 10, currency: 'SGD' } }).result).resolves.toEqual({ result: '10' });
  });

  it('exposes only declared into inputs and responses and omits next on return-only stages', () => {
    interface I { input: number }
    interface O { result: string }
    type Targets = {
      thunk: () => Pipeline<I, O, {}>;
      slot: DynamicTarget<'selected', I, O, {}>;
    };
    const check = async (into: IntoMap<Targets>) => {
      const { result } = await into.thunk({ input: 1, extra: true }, { signal: new AbortController().signal });
      const back = await into.slot('selected', { input: 2, extra: true }, { signal: new AbortController().signal });
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
      name: 'forward', request: { needs: ['input'] }, into: { thunk: passthrough, slot: passthrough },
      execute: async (facts, into) => await into.thunk(facts),
    });
    const through = defineStage<I, I, O, O>({
      name: 'pass through interface', through: passthrough, execute: async (facts, next) => await next(facts),
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
    expect([check, stage, through, invalid]).toHaveLength(4);
  });
});
