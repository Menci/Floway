import { describe, expect, it } from 'vitest';

import { compose, fragment, pipeline } from '../src/compose.ts';
import type { PipelineBuilder } from '../src/compose.ts';
import { runPipeline } from '../src/run.ts';
import { defineRequestStage, defineStage, dispatch, handoff, terminal } from '../src/stage.ts';
import type { Facts } from '../src/types.ts';

describe('pipeline composition', () => {
  it('supports request stages, ordinary stages, fragments, and terminal endings', async () => {
    const makeRequest = defineStage<
      { input: string },
      { first: string },
      number,
      number,
      never,
      Record<never, never>
    >({
      name: 'make-request',
      provides: ['first'],
      execute: async (facts, next, env) => {
        env.log.info('request');
        return await next({ first: `${facts.input}!` });
      },
    });
    const request = defineRequestStage<
      { first: string },
      { parsed: number },
      'first',
      Record<never, never>
    >({
      name: 'parse',
      consumes: ['first'],
      provides: ['parsed'],
      execute: async (facts, next) => await next({ parsed: facts.first.length }),
    });
    const shared = fragment<{ parsed: number }>()
      .use(defineStage<{ parsed: number }, { doubled: number }, number, number, never, Record<never, never>>({
        name: 'double',
        provides: ['doubled'],
        execute: async (facts, next) => await next({ doubled: facts.parsed * 2 }),
      }));
    const body = pipeline<{ input: string }>('composition')
      .use(makeRequest)
      .use(request)
      .useFragment(shared)
      .end(terminal<{ doubled: number }, number, Record<never, never>>(
        'finish',
        async facts => facts.doubled,
      ));

    await expect(runPipeline(body, { input: 'hello' })).resolves.toBe(12);
  });

  it('keeps option bags valid for request stages and composes with the functional API', async () => {
    const stage = defineRequestStage<{ input: string }, { marker?: string }, never, Record<never, never>>({
      name: 'optional',
      execute: async (_facts, next) => await next({}),
    });
    const built = pipeline<{ input: string }>('functional')
      .use(stage)
      .end(terminal<{ input: string }, string, Record<never, never>>('answer', async facts => facts.input));
    const composed = compose('composed', pipeline<{ input: string }>('unused').use(stage), terminal('done', async (facts: { input: string }) => facts.input));
    await expect(runPipeline(built, { input: 'x' })).resolves.toBe('x');
    await expect(runPipeline(composed, { input: 'y' })).resolves.toBe('y');
  });

  it('dispatches to the selected pipeline through a typed handoff', async () => {
    const target = pipeline<{ value: bigint }>('target')
      .end(terminal<{ value: bigint }, string, Record<never, never>>('target-end', async facts => facts.value.toString()));
    const root = pipeline<{ value: bigint }>('root')
      .end(dispatch<{ value: bigint }, string, Record<never, never>>(
        'select',
        facts => handoff(target, { value: facts.value }),
      ));
    await expect(runPipeline(root, { value: 123n })).resolves.toBe('123');
  });

  it('keeps a zero-stage terminal pipeline output strongly typed', async () => {
    const onlyTerminal = pipeline<{ input: string }>('terminal-only')
      .end(terminal<{ input: string }, number, Record<never, never>>('only', async facts => facts.input.length));
    const value: number = await runPipeline(onlyTerminal, { input: 'abc' });
    expect(value).toBe(3);
  });

  it('requires service options only for pipelines with required services', async () => {
    const noServices = pipeline<{ input: string }>('no-services')
      .end(terminal<{ input: string }, string, Record<never, never>>('end', async facts => facts.input));
    await expect(runPipeline(noServices, { input: 'ok' })).resolves.toBe('ok');

    type Services = { readonly prefix: string };
    const withServices = pipeline<{ input: string }>('services')
      .end(terminal<{ input: string }, string, Services>('service-end', async (facts, env) => facts.input + env.prefix));
    // @ts-expect-error Required services must be provided.
    const missingServices = runPipeline(withServices, { input: 'x' });
    void missingServices;
    await expect(runPipeline(withServices, { input: 'x' }, { services: { prefix: '!' } })).resolves.toBe('x!');
  });

  it('preserves the full fact flow across a fifteen-stage mixed pipeline', async () => {
    type State = { count: number; text: string; optional?: string };
    let builder: PipelineBuilder<State, any, any, any, any> = pipeline<State>('fifteen');
    for (let index = 0; index < 5; index++) {
      builder = builder.use(defineRequestStage<State, { text: string }, 'text', Record<never, never>>({
        name: `request-${index}`,
        consumes: ['text'],
        provides: ['text'],
        execute: async (facts, next) => await next({ text: `${facts.text}${index}` }),
      }));
    }
    for (let index = 0; index < 5; index++) {
      builder = builder.use(defineStage<State, { count: number }, State, State, 'count', Record<never, never>>({
        name: `stage-${index}`,
        consumes: ['count'],
        provides: ['count'],
        execute: async (facts, next) => await next({ count: facts.count + index + 1 }),
      }));
    }
    const layered = fragment<State>()
      .use(defineStage<State, { optional?: string }, State, State, never, Record<never, never>>({
        name: 'optional-clear',
        provides: ['optional'],
        execute: async (_facts, next) => await next({ optional: undefined }),
      }));
    builder = builder.useFragment(layered).useFragment(layered);
    const final = builder.end(terminal<State, Facts, Record<never, never>>('terminal', async facts => facts));
    await expect(runPipeline(final, { count: 0, text: 'a' })).resolves.toMatchObject({ count: 15, text: 'a01234' });
  });

  it('emits readable missing-fact compile-time diagnostics', () => {
    const needsInput = defineStage<{ input: string }, Record<never, never>, string, string>({
      name: 'needs-input',
      execute: async (facts, next) => await next(),
    });
    // @ts-expect-error The builder tracks the entry facts and rejects a missing input.
    pipeline<Record<never, never>>('invalid').use(needsInput);
    expect(needsInput.name).toBe('needs-input');
  });

  it('rejects incompatible upward outcomes and consumed fact reads at compile time', () => {
    const expectsStringInner = defineStage<{ a: string }, { b: number }, string, string, 'a'>({
      name: 'consume-a',
      consumes: ['a'],
      execute: async (facts, next) => await next({ b: facts.a.length }),
    });
    const readsConsumedA = defineStage<{ a: string }, Record<never, never>, string, string>({
      name: 'reads-consumed-a',
      execute: async (_facts, next) => await next(),
    });
    const returnsNumberOut = defineStage<{ b: number }, Record<never, never>, number, number>({
      name: 'returns-number',
      execute: async (_facts, next) => await next(),
    });
    const returnsNumberEnd = terminal<{ b: number }, number>('num-end', async facts => facts.b);

    // @ts-expect-error Fact "a" was consumed by expectsStringInner.
    pipeline<{ a: string }>('consumed-err').use(expectsStringInner).use(readsConsumedA);

    // @ts-expect-error Stage returns number, which does not satisfy expected inner outcome string.
    pipeline<{ a: string }>('stage-outcome-err').use(expectsStringInner).use(returnsNumberOut);

    // @ts-expect-error Ending returns number, which does not satisfy expected inner outcome string.
    pipeline<{ a: string }>('ending-outcome-err').use(expectsStringInner).end(returnsNumberEnd);

    const target = pipeline<{ x: number }>('target').end(terminal<{ x: number }, string>('t', async f => String(f.x)));
    // @ts-expect-error Handoff input must match target's entry facts.
    const badHandoff = () => handoff(target, { x: 'not-a-number' });
    void badHandoff;

    expect(expectsStringInner.consumes).toEqual(['a']);
  });

  it('infers the root outcome through ordinary stages and request stages', async () => {
    const ordinary = pipeline<{ input: string }>('ordinary')
      .use(defineStage<{ input: string }, Record<never, never>, number, number, never, Record<never, never>>({
        name: 'ordinary',
        async execute(_facts, next) {
          const count = await next();
          return count;
        },
      }))
      .end(terminal<{ input: string }, number, Record<never, never>>('ordinary-end', async () => 1));
    const ordinaryResult: number = await runPipeline(ordinary, { input: 'x' });

    const request = pipeline<{ input: string }>('request')
      .use(defineRequestStage<{ input: string }, Record<never, never>, never, Record<never, never>>({
        name: 'request',
        async execute(_facts, next) {
          return await next();
        },
      }))
      .end(terminal<{ input: string }, string, Record<never, never>>('request-end', async facts => facts.input));
    const requestResult: string = await runPipeline(request, { input: 'x' });
    expect([ordinaryResult, requestResult]).toEqual([1, 'x']);
  });

  it('replaces fragment fact types and keeps finish out of the public builder', () => {
    const replacement = fragment<{ x: string }>()
      .use(defineStage<{ x: string }, { x: number }, number, number, never, Record<never, never>>({
        name: 'replace',
        provides: ['x'],
        execute: async (_facts, next) => await next({ x: 1 }),
      }));
    const merged = pipeline<{ x: string }>('merge').useFragment(replacement);
    const acceptsNumber = (builder: typeof merged) => builder.use(
      defineStage<{ x: number }, Record<never, never>, number, number, never, Record<never, never>>({
        name: 'uses-number',
        execute: async (_facts, next) => await next(),
      }),
    );
    acceptsNumber(merged).end(terminal<{ x: number }, number>('end', async facts => facts.x));
    // @ts-expect-error Fragment replacement must not leave x as string.
    merged.use(defineStage<{ x: string }, Record<never, never>, number, number, never, Record<never, never>>({
      name: 'uses-string',
      execute: async (_facts, next) => await next(),
    }));
    const rejectUncheckedFinish = () => {
      // @ts-expect-error finish is an internal composition operation.
      merged.finish('bypass', terminal<{ x: number }, number>('bypass-end', async facts => facts.x));
    };
    void rejectUncheckedFinish;
    expect(merged).toBeDefined();
  });

  it('clears provided keys before applying a partial continuation payload', async () => {
    const clear = defineStage<{ x: string }, { x?: number }, string, string, never, Record<never, never>>({
      name: 'clear-provided',
      provides: ['x'],
      execute: async (_facts, next) => await next({}),
    });
    const inspect = defineStage<{ x?: number }, Record<never, never>, string, string, never, Record<never, never>>({
      name: 'inspect-cleared',
      execute: async (facts, next) => await next(),
    });
    let observed: unknown = 'unset';
    const result = pipeline<{ x: string }>('clear')
      .use(clear)
      .use(defineStage<{ x?: number }, Record<never, never>, string, string, never, Record<never, never>>({
        name: 'observe-cleared',
        execute: async (facts, next) => {
          observed = facts.x;
          return await next();
        },
      }))
      .use(inspect)
      .end(terminal<{ x?: number }, string>('end', async () => 'ok'));
    await expect(runPipeline(result, { x: 'old' })).resolves.toBe('ok');
    expect(observed).toBeUndefined();
  });
});
