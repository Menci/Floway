import { describe, expect, expectTypeOf, it } from 'vitest';

import { compose, DeclarationViolationError, defineEnding, defineStage, link, run } from '../src/index.ts';
import type { IntoMap, Pipeline, StaticTarget } from '../src/index.ts';

type Input = { input: number };
type Output = { result: string };
type Space = Input & Output;
const options = { services: {}, finalizationTimeoutMs: 100 };
const empty = { needs: [], consumes: [], provides: [] };
const passthrough = { request: empty, response: { ...empty, needs: ['result'] } };
const terminal = defineEnding<Input, Output>({
  name: 'leaf', request: { needs: ['input'] }, return: { provides: ['result'] },
  execute: async ({ input }) => ({ result: String(input) }),
});

describe('composition', () => {
  it('checks, copies and freezes the explicit boundary keys across edits and synthetic answers', () => {
    type Seed = { seed: number };
    type Formatted = { outer: string };
    const stage = defineStage<Seed, Input, Output, Formatted>({
      name: 'format',
      through: {
        request: { needs: ['seed'], consumes: ['seed'], provides: ['input'] },
        response: { needs: ['result'], consumes: ['result'], provides: ['outer'] },
      },
      return: { provides: ['outer', 'optional'] },
      execute: async ({ seed, ...rest }, scope) => {
        const { result, ...back } = await scope.next({ ...rest, input: seed });
        return { ...back, outer: result };
      },
    });
    const entry: 'seed'[] = ['seed'];
    const exit: 'outer'[] = ['outer'];
    const pipeline = compose<Seed & Formatted>()('format', { entry, exit, stages: [stage], ending: terminal });
    entry.length = 0;
    exit.length = 0;
    expect(pipeline.entry).toEqual(['seed']);
    expect(pipeline.exit).toEqual(['outer']);
    expect(Object.isFrozen(pipeline.entry)).toBe(true);
    expect(Object.isFrozen(pipeline.exit)).toBe(true);
  });

  it('infers the input, optional input and output types from the declared arrays', () => {
    const pipeline = compose<Space & { websocket?: string; skipped: boolean }>()('inferred', {
      entry: ['input'], optionalEntry: ['websocket'], exit: ['result'], stages: [], ending: terminal,
    });
    expectTypeOf(pipeline).toEqualTypeOf<Pipeline<
      { readonly input: number } & { readonly websocket?: string }, { readonly result: string }, {}
    >>();
  });

  it('rejects undeclared required entry keys and phantom exit keys at composition', () => {
    expect(() => compose<Space>()('missing', { entry: [], exit: ['result'], stages: [], ending: terminal }))
      .toThrow('entry does not guarantee "input"');
    expect(() => compose<{ input?: number; result: string }>()('optional', {
      entry: [], optionalEntry: ['input'], exit: ['result'], stages: [], ending: terminal,
    })).toThrow('entry does not guarantee "input"');
    expect(() => compose<Space & { phantom: boolean }>()('phantom', {
      entry: ['input'], exit: ['result', 'phantom'], stages: [], ending: terminal,
    })).toThrow('no response path guarantees "phantom"');
  });

  it.each([
    { entry: ['input', 'input'], exit: ['result'], message: 'duplicate "input" in entry' },
    { entry: ['input'], optionalEntry: ['websocket', 'websocket'], exit: ['result'], message: 'duplicate "websocket" in optionalEntry' },
    { entry: ['input'], optionalEntry: ['input'], exit: ['result'], message: '"input" appears in both entry and optionalEntry' },
    { entry: ['input'], exit: ['result', 'result'], message: 'duplicate "result" in exit' },
  ] as const)('rejects ambiguous key arrays ($message)', ({ message, ...keys }) => {
    expect(() => compose<Space & { websocket?: string }>()('duplicate keys', {
      entry: [...keys.entry], optionalEntry: [...(keys.optionalEntry ?? [])], exit: [...keys.exit], stages: [], ending: terminal,
    })).toThrow(message);
  });

  it('rejects a later need for a consumed key, response needs missing on a synthetic branch, and duplicate names', () => {
    const consume = defineStage({
      name: 'consume', through: { request: { ...empty, consumes: ['input'] }, response: empty },
      execute: async (facts, scope) => await scope.next(facts),
    });
    expect(() => compose<Space>()('consumed', { entry: ['input'], exit: ['result'], stages: [consume], ending: terminal }))
      .toThrow('consumed by an earlier stage');

    const outer = defineStage({
      name: 'outer', through: passthrough,
      execute: async (facts, scope) => await scope.next(facts),
    });
    const synthetic = defineStage({
      name: 'only-answer', return: { provides: ['different'] },
      execute: async () => ({ different: 17 }),
    });
    expect(() => compose<Space>()('uncovered', { entry: ['input'], exit: ['result'], stages: [outer, synthetic], ending: terminal }))
      .toThrow('no child guarantees "result"');
    expect(() => compose<Space>()('duplicate', { entry: ['input'], exit: ['result'], stages: [outer, outer], ending: terminal }))
      .toThrow('Duplicate stage');
  });

  it('links TDZ-safe mutual recursion and resolves each static thunk once', async () => {
    type Targets = { other: StaticTarget<Input, Output, {}> };
    const ending = defineEnding<Input, Output, Targets>({
      name: 'recur', request: { needs: ['input'] }, return: { provides: ['result'] },
      into: { other: { ...passthrough, request: { ...empty, provides: ['input'] } } },
      execute: async (facts, scope) => facts.input > 0 ? await scope.into.other({ input: facts.input - 1 }) : ({ result: 'done' }),
    });
    let resolutions = 0;
    const a: Pipeline<Input, Output> = compose<Space>()('a', {
      entry: ['input'], exit: ['result'], stages: [], ending, targets: { other: () => { resolutions++; return b; } },
    });
    const b: Pipeline<Input, Output> = compose<Space>()('b', {
      entry: ['input'], exit: ['result'], stages: [], ending, targets: { other: () => { resolutions++; return a; } },
    });
    expect(resolutions).toBe(0);
    await expect(run(a, { input: 2 }, options).result).rejects.toThrow('unlinked targets');
    link([a]);
    link([b, a]);
    expect(resolutions).toBe(2);
    await expect(run(a, { input: 2 }, options).result).resolves.toEqual({ result: 'done' });
    expect(resolutions).toBe(2);
  });

  it('checks declared translations in both directions', async () => {
    type Source = { source: string };
    type Translated = { output: string };
    type Targets = { leaf: StaticTarget<Input, Output, {}> };
    const leaf = compose<Space>()('leaf', { entry: ['input'], exit: ['result'], stages: [], ending: terminal });
    const ending = defineEnding<Source, Translated, Targets>({
      name: 'translate', request: { needs: ['source'] }, return: { provides: ['output', 'optional'] },
      into: {
        leaf: {
          request: { needs: ['source'], consumes: ['source'], provides: ['input'] },
          response: { needs: ['result'], consumes: ['result'], provides: ['output'] },
        },
      },
      execute: async ({ source, ...rest }, scope) => {
        if (source === 'stub') return { output: 'stub', optional: true };
        const request = { ...rest, input: Number(source), ...(source === 'bad request' ? { extra: 1 } : {}) };
        const { result, ...back } = await scope.into.leaf(request);
        return { ...back, output: result, ...(source === 'bad response' ? { result } : {}) };
      },
    });
    const boundary = { entry: ['source'], exit: ['output'] } as const;
    const pipeline = compose<Source & Translated>()('translate', { ...boundary, stages: [], ending, targets: { leaf } });
    link([pipeline]);
    await expect(run(pipeline, { source: '4' }, options).result).resolves.toEqual({ output: '4' });
    await expect(run(pipeline, { source: 'stub' }, options).result).resolves.toEqual({ output: 'stub', optional: true });
    await expect(run(pipeline, { source: 'bad request' }, options).result).rejects.toThrow('added undeclared "extra"');
    await expect(run(pipeline, { source: 'bad response' }, options).result).rejects.toThrow('declared consuming "result"');

    const extra = { leaf, smuggled: leaf };
    expect(() => compose<Source & Translated>()('extra', { ...boundary, stages: [], ending, targets: extra })).toThrow('undeclared target "smuggled"');
  });

  it('validates cross-pipeline entry and exit when linking', () => {
    type Targets = { leaf: StaticTarget<Input, Output, {}> };
    const target = compose<Space>()('leaf', { entry: ['input'], exit: ['result'], stages: [], ending: terminal });
    const ending = defineEnding<Input, Output, Targets>({
      name: 'forward', request: { needs: [] }, into: { leaf: passthrough },
      execute: async (facts, scope) => await scope.into.leaf(facts),
    });
    const consume = defineStage({
      name: 'consume', through: { request: { ...empty, consumes: ['input'] }, response: passthrough.response },
      execute: async (facts, scope) => await scope.next(facts),
    });
    const missingEntry = compose<Space>()('missing entry', {
      entry: ['input'], exit: ['result'], stages: [consume], ending, targets: { leaf: () => target },
    });
    expect(() => link([missingEntry])).toThrow(DeclarationViolationError);
    expect(() => link([missingEntry])).toThrow('target "leaf" requires "input"');

    const missingExit = compose<Space>()('missing exit', {
      entry: ['input'], exit: [], stages: [], targets: { leaf: target },
      ending: defineEnding<Input, Output, Targets>({
        name: 'missing response', request: { needs: [] }, into: { leaf: { request: empty, response: { ...empty, needs: ['missing'] } } },
        execute: async (facts, scope) => await scope.into.leaf(facts),
      }),
    });
    expect(() => link([missingExit])).toThrow('target "leaf" does not guarantee "missing"');
  });

  it('requires only the selected ending slot’s request needs', async () => {
    type Input = { route: 'a' | 'b'; a?: number; b?: number };
    type Targets = { a: StaticTarget<Input, Output, {}>; b: StaticTarget<Input, Output, {}> };
    const leaf = compose<Input & Output>()('leaf', {
      entry: ['route'], optionalEntry: ['a', 'b'], exit: ['result'], stages: [], ending: defineEnding<Input, Output>({
        name: 'leaf', request: { needs: ['route'] }, return: { provides: ['result'] },
        execute: async facts => ({ result: String(facts[facts.route]) }),
      }),
    });
    const router = compose<Input & Output>()('router', {
      entry: ['route'], optionalEntry: ['a', 'b'], exit: ['result'], stages: [], targets: { a: leaf, b: leaf },
      ending: defineEnding<Input, Output, Targets>({
        name: 'route', request: { needs: ['route'] },
        into: {
          a: { ...passthrough, request: { ...empty, needs: ['a'] } },
          b: { ...passthrough, request: { ...empty, needs: ['b'] } },
        },
        execute: async (facts, scope) => await scope.into[facts.route](facts),
      }),
    });
    link([router]);
    await expect(run(router, { route: 'a', a: 12 }, options).result).resolves.toEqual({ result: '12' });
    await expect(run(router, { route: 'b', a: 12 }, options).result).rejects.toThrow('missing "b"');
    expect(router.entry).toEqual(['route']);
  });

  it('requires the composing service slice to cover all targets', async () => {
    type Ports = { price: () => number };
    type Services = Ports & { currency: string };
    type Targets = { price: StaticTarget<{}, Output, Ports> };
    const target = compose<Output, Ports>()('target', {
      entry: [], exit: ['result'], stages: [], ending: defineEnding<{}, Output, {}, Ports>({
        name: 'price', request: { needs: [] }, return: { provides: ['result'] },
        execute: async (_facts, scope) => ({ result: String(scope.services.price()) }),
      }),
    });
    const targets: Targets = { price: () => target };
    const ending = defineEnding<{}, Output, Targets>({
      name: 'route', request: { needs: [] }, into: { price: passthrough },
      execute: async (facts, scope) => await scope.into.price(facts),
    });
    const missingPorts = () => {
      // @ts-expect-error The thunk's target requires the price port.
      compose<Output>()('invalid', { entry: [], exit: ['result'], stages: [], ending, targets });
    };
    expect(typeof missingPorts).toBe('function');
    const pipeline = compose<Output, Services>()('valid', { entry: [], exit: ['result'], stages: [], ending, targets });
    link([pipeline]);
    await expect(run(pipeline, {}, { ...options, services: { price: () => 10, currency: 'SGD' } }).result).resolves.toEqual({ result: '10' });
  });

  it('exposes only declared into inputs and responses and omits next on return-only stages', () => {
    interface I { input: number }
    interface O { result: string }
    type Targets = { thunk: () => Pipeline<I, O>; direct: Pipeline<I, O> };
    const check = async (into: IntoMap<Targets>) => {
      const { result } = await into.thunk({ input: 1, extra: true }, { signal: new AbortController().signal });
      const back = await into.direct({ input: 2, extra: true });
      // @ts-expect-error Unknown target.
      await into.unregistered({ input: 1 });
      // @ts-expect-error Wrong input type.
      await into.thunk({ input: '1' });
      // @ts-expect-error Unknown response field.
      back.other;
      return result.concat(back.result);
    };
    const stage = defineStage<I, O>({
      name: 'answer', return: { provides: ['result'] },
      execute: async (facts, scope) => {
        // @ts-expect-error A return-only stage cannot call next.
        await scope.next(facts);
        return { result: String(facts.input) };
      },
    });
    const ending = defineEnding<I, O, Targets>({
      name: 'forward', request: { needs: ['input'] }, into: { thunk: passthrough, direct: passthrough },
      execute: async (facts, scope) => await scope.into.thunk(facts),
    });
    const through = defineStage<I, I, O, O>({
      name: 'pass through interface', through: passthrough, execute: async (facts, scope) => await scope.next(facts),
    });
    const boundary = { entry: ['input'], exit: ['result'], stages: [] } as const;
    const leaf = compose<Space>()('leaf', { ...boundary, ending: terminal });
    const invalid = () => {
      // @ts-expect-error The direct slot is required by Targets.
      compose<Space>()('missing slot', { ...boundary, targets: { thunk: () => leaf }, ending });
      // @ts-expect-error A terminal cannot serve as this target-aware ending.
      compose<Space>()('wrong ending', { ...boundary, targets: { thunk: () => leaf, direct: leaf }, ending: terminal });
      // @ts-expect-error Optional keys cannot appear in entry.
      compose<{ input?: number; result: string }>()('optional entry', { ...boundary, ending: terminal });
    };
    expect([check, stage, through, invalid]).toHaveLength(4);
  });
});
