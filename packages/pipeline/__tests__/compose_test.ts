import { describe, expect, expectTypeOf, it } from 'vitest';

import { factSpace, transform } from '../src/index.ts';
import type { Pipeline } from '../src/index.ts';

interface Space {
  readonly 'request.initial': number;
  readonly 'request.replaced': string;
  readonly 'request.maybe': string;
  readonly 'response.value': number;
  readonly 'response.optional': number;
  readonly 'response.extra': boolean;
}

const { compose, defineStage } = factSpace<Space>();
const untouched = { needs: [], provides: [], consumes: [] } as const;
const valueEnding = defineStage({
  name: 'value',
  request: { needs: [] },
  return: { provides: ['response.value'] },
  execute: async () => ({ 'response.value': 1 }),
});

describe('composition', () => {
  it('derives required and optional keys for stage and pipeline contracts', () => {
    const ending = defineStage({
      name: 'optional',
      request: { needs: ['request.initial', 'request.maybe?'] },
      return: { provides: ['response.value', 'response.optional?'] },
      execute: async facts => {
        type Expected = {
          readonly 'request.initial': number;
          readonly 'request.maybe'?: string;
        };
        expectTypeOf(facts).toExtend<Expected>();
        expectTypeOf<Expected>().toExtend<typeof facts>();
        return {
          'response.value': facts['request.initial'],
          ...(facts['request.maybe'] && { 'response.optional': 2 }),
        };
      },
    });
    const pipeline = compose('optional', {
      entry: ['request.initial', 'request.maybe?'],
      exit: ['response.value', 'response.optional?'],
      stages: [],
      ending,
    });
    expectTypeOf(pipeline).toExtend<Pipeline<
      { readonly 'request.initial': number; readonly 'request.maybe'?: string },
      { readonly 'response.value': number; readonly 'response.optional'?: number }
    >>();
    expectTypeOf<{ 'request.initial': number; 'request.maybe': undefined }>()
      .not.toExtend<NonNullable<typeof pipeline extends Pipeline<infer I, unknown> ? I : never>>();
    expect(pipeline.entry).toEqual(['request.initial', 'request.maybe?']);
  });

  it('rejects mismatched entry and exit sets when composed', () => {
    expect(() => compose('extra-entry', {
      entry: ['request.initial'], exit: ['response.value'], stages: [], ending: valueEnding,
    })).toThrow('entry disagrees');
    expect(() => compose('missing-exit', {
      entry: [], exit: [], stages: [], ending: valueEnding,
    })).toThrow('exit disagrees');
    expect(() => compose('optional-exit', {
      entry: [], exit: ['response.value?'], stages: [], ending: valueEnding,
    })).toThrow('exit disagrees');
  });

  it('requires a consumed key to be provided before another stage can need it', () => {
    const consume = defineStage({
      name: 'consume',
      through: {
        request: { needs: ['request.initial'], provides: [], consumes: ['request.initial'] },
        response: { ...untouched, needs: ['response.value'] },
      },
      execute: transform(() => ({
        request: ({ 'request.initial': _initial, ...facts }) => facts,
      })),
    });
    const provide = defineStage({
      name: 'provide',
      through: {
        request: { ...untouched, provides: ['request.initial'] },
        response: { ...untouched, needs: ['response.value'] },
      },
      execute: transform(() => ({
        request: facts => ({ ...facts, 'request.initial': 2 }),
      })),
    });
    const ending = defineStage({
      name: 'requires-initial',
      request: { needs: ['request.initial'] },
      return: { provides: ['response.value'] },
      execute: async facts => ({ 'response.value': facts['request.initial'] }),
    });
    expect(() => compose('reprovided', {
      entry: ['request.initial'], exit: ['response.value'], stages: [consume, provide], ending,
    })).not.toThrow();
    expect(() => compose('missing', {
      entry: ['request.initial'], exit: ['response.value'], stages: [consume], ending,
    })).toThrow('after it was consumed');
  });

  it('checks outer required responses against an in-place answer path', () => {
    const needsExtra = defineStage({
      name: 'requires-extra',
      through: { request: untouched, response: { ...untouched, needs: ['response.extra'] } },
      execute: async (facts, scope) => await scope.next(facts),
    });
    const ending = defineStage({
      name: 'extra',
      request: { needs: [] },
      return: { provides: ['response.extra'] },
      execute: async () => ({ 'response.extra': true }),
    });
    expect(() => compose('covered', {
      entry: [], exit: ['response.extra'], stages: [needsExtra], ending,
    })).not.toThrow();
    expect(() => compose('uncovered', {
      entry: [], exit: ['response.extra'], stages: [needsExtra], ending: valueEnding,
    })).toThrow('child response does not guarantee "response.extra"');
  });

  it('checks the closed into target set and confines into to the ending', () => {
    const into = defineStage({
      name: 'into',
      request: { needs: [] },
      into: { value: { request: untouched, response: { ...untouched, needs: ['response.value'] } } },
      execute: async (facts, scope) => await scope.into.value(facts),
    });
    const target = compose('target', { entry: [], exit: ['response.value'], stages: [], ending: valueEnding });
    expect(() => compose('linked', {
      entry: [], exit: ['response.value'], stages: [], ending: into, targets: { value: () => target },
    })).not.toThrow();
    expect(() => compose('missing-target', {
      entry: [], exit: ['response.value'], stages: [], ending: into,
    })).toThrow('has no target "value"');
    expect(() => compose('extra-target', {
      entry: [], exit: ['response.value'], stages: [], ending: into, targets: { value: target, other: target },
    })).toThrow('undeclared target "other"');
    expect(() => compose('non-ending', {
      entry: [], exit: ['response.value'], stages: [into], ending: valueEnding,
    })).toThrow('declares into outside ending');
  });
});
