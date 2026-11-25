import { describe, expect, expectTypeOf, it } from 'vitest';

import { host } from './run-fixture.ts';
import { factSpace, run, transform } from '../src/index.ts';

const none = { needs: [], provides: [], consumes: [] } as const;

describe('composition', () => {
  it('derives optional boundaries and rejects required or unlisted differences at composition', async () => {
    const { defineStage, compose } = factSpace<{
      'request.text': string;
      'request.mode'?: string;
      'response.text': string;
      'response.mode'?: string;
    }>();
    const ending = defineStage({
      name: 'echo',
      request: { needs: ['request.text', 'request.mode?'] },
      return: { provides: ['response.text', 'response.mode?'] },
      execute: async facts => ({
        'response.text': facts['request.text'],
        ...(facts['request.mode'] === undefined ? {} : { 'response.mode': facts['request.mode'] }),
      }),
    });
    const pipeline = compose('echo', {
      entry: ['request.text', 'request.mode?'], exit: ['response.text', 'response.mode?'], stages: [], ending,
    });
    const recording = host({});
    const missing = run(pipeline, { 'request.text': 'a' }, recording.options);
    expectTypeOf(missing.result).resolves.toExtend<{ 'response.text': string; 'response.mode'?: string }>();
    expectTypeOf<{ 'response.mode': undefined }>().not.toExtend<{ 'response.mode'?: string }>();
    await expect(missing.result).resolves.toEqual({ 'response.text': 'a' });
    await expect(run(pipeline, { 'request.text': 'b', 'request.mode': 'full' }, host({}).options).result)
      .resolves.toEqual({ 'response.text': 'b', 'response.mode': 'full' });
    expect(() => compose('entry mismatch', {
      entry: ['request.text', 'request.mode'], exit: ['response.text', 'response.mode?'], stages: [], ending,
    })).toThrow('entry disagrees with the stages on "request.mode"');
    expect(() => compose('exit mismatch', {
      entry: ['request.text', 'request.mode?'], exit: ['response.text'], stages: [], ending,
    })).toThrow('exit disagrees with the stages on "response.mode"');
  });

  it('checks consumed requests along the suffix and accepts explicitly provided replacements', async () => {
    const { defineStage, compose } = factSpace<{ 'request.text': string; 'response.text': string }>();
    const end = defineStage({
      name: 'end',
      request: { needs: ['request.text'] },
      return: { provides: ['response.text'] },
      execute: async facts => ({ 'response.text': facts['request.text'] }),
    });
    const consume = defineStage({
      name: 'remove',
      through: { request: { ...none, needs: ['request.text'], consumes: ['request.text'] }, response: none },
      execute: async ({ 'request.text': _old, ...facts }, scope) => await scope.next(facts),
    });
    const restore = defineStage({
      name: 'restore',
      through: { request: { ...none, provides: ['request.text'] }, response: none },
      execute: async (facts, scope) => await scope.next({ ...facts, 'request.text': 'new' }),
    });
    expect(() => compose('missing', { entry: ['request.text'], exit: ['response.text'], stages: [consume], ending: end }))
      .toThrow('requires "request.text" after it was consumed');
    const pipeline = compose('restore', { entry: ['request.text'], exit: ['response.text'], stages: [consume, restore], ending: end });
    await expect(run(pipeline, { 'request.text': 'old' }, host({}).options).result).resolves.toEqual({ 'response.text': 'new' });
  });

  it('checks in-place answers against required result facts of callers', () => {
    const { defineStage, compose } = factSpace<{ 'response.text': string }>();
    const requireText = defineStage({
      name: 'calls',
      through: { request: none, response: { ...none, needs: ['response.text'] } },
      execute: async (facts, scope) => await scope.next(facts),
    });
    const maybeText = defineStage({
      name: 'answers',
      request: none,
      return: { provides: ['response.text?'] },
      execute: async () => ({}),
    });
    expect(() => compose('shortfall', { entry: [], exit: ['response.text'], stages: [requireText], ending: maybeText }))
      .toThrow('child response does not guarantee "response.text"');
  });

  it('validates closed into targets and checks their entry and exit during composition', async () => {
    const { defineStage, compose } = factSpace<{ 'request.input': string; 'request.target': string; 'response.text': string }>();
    const end = defineStage({
      name: 'inner',
      request: { needs: ['request.target'] },
      return: { provides: ['response.text'] },
      execute: async facts => ({ 'response.text': facts['request.target'] }),
    });
    const target = compose('target', { entry: ['request.target'], exit: ['response.text'], stages: [], ending: end });
    const into = defineStage({
      name: 'route',
      request: { needs: ['request.input'] },
      into: {
        target: {
          request: { needs: ['request.input'], provides: ['request.target'], consumes: ['request.input'] },
          response: { ...none, needs: ['response.text'] },
        },
      },
      execute: async ({ 'request.input': input, ...facts }, scope) =>
        await scope.into.target({ ...facts, 'request.target': input }),
    });
    const boundary = { entry: ['request.input'], exit: ['response.text'], stages: [], ending: into } as const;
    expect(() => compose('no target', boundary)).toThrow('has no target "target"');
    expect(() => compose('extra target', { ...boundary, targets: { target, extra: target } })).toThrow('undeclared target "extra"');
    expect(() => compose('misplaced target', { ...boundary, stages: [into], ending: end })).toThrow('declares into outside ending');
    const incompatible = compose('incompatible', {
      entry: [], exit: [], stages: [],
      ending: defineStage({ name: 'empty', request: none, return: { provides: [] }, execute: async () => ({}) }),
    });
    expect(() => compose('wrong output', { ...boundary, targets: { target: incompatible } })).toThrow('response does not guarantee "response.text"');
    const pipeline = compose('route', { ...boundary, targets: { target } });
    const recording = host({});
    await expect(run(pipeline, { 'request.input': 'routed' }, recording.options).result).resolves.toEqual({ 'response.text': 'routed' });
    expect(recording.events).toContainEqual({
      type: 'stage.entered', stageId: 2, parentStageId: 1, name: 'inner', facts: { 'request.target': 'routed' },
    });
  });

  it('gives both transform directions the same invocation-local closure', async () => {
    const { defineStage, compose } = factSpace<{ 'request.text': string; 'response.text': string }>();
    const count = defineStage({
      name: 'count',
      through: {
        request: { ...none, needs: ['request.text'], provides: ['request.text'] },
        response: { ...none, needs: ['response.text'], provides: ['response.text'] },
      },
      execute: transform(() => {
        let length = 0;
        return {
          request: facts => {
            length = facts['request.text'].length;
            return { ...facts, 'request.text': facts['request.text'].toUpperCase() };
          },
          response: facts => ({ ...facts, 'response.text': `${facts['response.text']}:${length}` }),
        };
      }),
    });
    const end = defineStage({
      name: 'echo',
      request: { needs: ['request.text'] },
      return: { provides: ['response.text'] },
      execute: async facts => ({ 'response.text': facts['request.text'] }),
    });
    const pipeline = compose('transform', { entry: ['request.text'], exit: ['response.text'], stages: [count], ending: end });
    await expect(Promise.all([
      run(pipeline, { 'request.text': 'one' }, host({}).options).result,
      run(pipeline, { 'request.text': 'three' }, host({}).options).result,
    ])).resolves.toEqual([{ 'response.text': 'ONE:3' }, { 'response.text': 'THREE:5' }]);
  });
});

describe('handoff assertions', () => {
  it('preserves a needed value when a stage does not need to update it', async () => {
    const { defineStage, compose } = factSpace<{ 'request.text': string; 'response.text': string }>();
    const stage = defineStage({
      name: 'conditional-update',
      through: { request: { ...none, needs: ['request.text'], provides: ['request.text'] }, response: none },
      execute: async (facts, scope) => await scope.next(facts),
    });
    const ending = defineStage({
      name: 'echo',
      request: { needs: ['request.text'] },
      return: { provides: ['response.text'] },
      execute: async facts => ({ 'response.text': facts['request.text'] }),
    });
    const pipeline = compose('conditional', { entry: ['request.text'], exit: ['response.text'], stages: [stage], ending });
    await expect(run(pipeline, { 'request.text': 'same' }, host({}).options).result).resolves.toEqual({ 'response.text': 'same' });
    await expect(run(pipeline, {} as { 'request.text': string }, host({}).options).result).rejects.toThrow('missing "request.text"');
  });

  it.each([
    ['new fact missing', { 'request.old': 'kept' }, 'missing "request.new"'],
    ['consumed fact present', { 'request.old': undefined, 'request.new': 'new' }, 'must consume "request.old"'],
  ] as const)('checks the request handoff when %s', async (_title, supplied, error) => {
    const { defineStage, compose } = factSpace<{ 'request.old': string; 'request.new': string }>();
    const stage = defineStage({
      name: 'convert',
      through: {
        request: { needs: ['request.old'], provides: ['request.new'], consumes: ['request.old'] },
        response: none,
      },
      execute: async (_facts, scope) => await scope.next(supplied as unknown as { 'request.new': string }),
    });
    const ending = defineStage({
      name: 'end',
      request: { needs: ['request.new'] },
      return: { provides: [] },
      execute: async () => ({}),
    });
    const pipeline = compose('convert', { entry: ['request.old'], exit: [], stages: [stage], ending });
    await expect(run(pipeline, { 'request.old': 'old' }, host({}).options).result).rejects.toThrow(error);
  });

  it.each([
    ['mix accepted answers', 2, 'selected', false],
    ['add an unknown fact', 2, 'unknown', true],
    ['change a single undeclared fact', 1, 'changed', true],
  ] as const)('checks continuation answer provenance when stages %s', async (_title, count, value, fails) => {
    const { defineStage, compose } = factSpace<{
      'request.attempt': number;
      'response.first': string;
      'response.second': string;
      'response.other': string;
    }>();
    const stage = defineStage({
      name: 'fork',
      through: { request: { ...none, provides: ['request.attempt'] }, response: none },
      execute: async (facts, scope) => {
        const first = await scope.next({ ...facts, 'request.attempt': 1 });
        if (count === 1) return { ...first, 'response.first': value };
        const second = await scope.next({ ...facts, 'request.attempt': 2 });
        return value === 'unknown' ? { ...first, ...second, 'response.other': value } : { ...first, ...second };
      },
    });
    const ending = defineStage({
      name: 'answers',
      request: { needs: ['request.attempt'] },
      return: { provides: ['response.first?', 'response.second?'] },
      execute: async facts => facts['request.attempt'] === 1 ? { 'response.first': 'a' } : { 'response.second': 'b' },
    });
    const pipeline = compose('fork', { entry: [], exit: ['response.first?', 'response.second?'], stages: [stage], ending });
    const outcome = run(pipeline, {}, host({}).options).result;
    if (fails) await expect(outcome).rejects.toThrow(/undeclared|outside its declarations/);
    else await expect(outcome).resolves.toEqual({ 'response.first': 'a', 'response.second': 'b' });
  });

  it.each(['return', 'continue', 'invalid'] as const)('validates a mixed declaration with an already answered child (%s)', async mode => {
    const { defineStage, compose } = factSpace<{ 'response.value': number; 'response.detail': string }>();
    const stage = defineStage({
      name: 'choose',
      through: { request: none, response: { ...none, needs: ['response.value', 'response.detail'] } },
      return: { provides: ['response.value'] },
      execute: async (facts, scope) => {
        const answer = await scope.next(facts);
        if (mode === 'return') return { 'response.value': 2 };
        if (mode === 'continue') return answer;
        return { ...answer, 'response.value': 3 };
      },
    });
    const ending = defineStage({
      name: 'answer',
      request: none,
      return: { provides: ['response.value', 'response.detail'] },
      execute: async () => ({ 'response.value': 1, 'response.detail': 'child' }),
    });
    const pipeline = compose('choose', { entry: [], exit: ['response.value', 'response.detail?'], stages: [stage], ending });
    const result = run(pipeline, {}, host({}).options).result;
    if (mode === 'invalid') await expect(result).rejects.toThrow('changed undeclared "response.value"');
    if (mode === 'return') await expect(result).resolves.toEqual({ 'response.value': 2 });
    if (mode === 'continue') await expect(result).resolves.toEqual({ 'response.value': 1, 'response.detail': 'child' });
  });
});
