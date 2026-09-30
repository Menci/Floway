import { expect, test } from 'vitest';

import { compose, defineStage, move, run } from '../src/index.ts';

type Request = { input: { value: string } };
type Response = { answer: string };

test('descends outermost-first and unwinds responses inside-out', async () => {
  const calls: string[] = [];
  const wrap = (name: string) => defineStage<Request, Request, Response, Response>({
    name,
    through: {
      request: { needs: ['input'], consumes: [], provides: [] },
      response: { needs: ['answer'], consumes: [], provides: [] },
    },
    execute: async (facts, next) => {
      calls.push(`${name}-before`);
      const result = await next(facts);
      calls.push(`${name}-after`);
      return result;
    },
  });
  const terminal = defineStage<Request, Response>({
    name: 'terminal', return: { provides: ['answer'] },
    execute: async facts => {
      calls.push('terminal');
      return move({ ...facts, answer: facts.input.value });
    },
  });
  const result = await run(compose<Request, Response>('order', [wrap('outer'), wrap('inner'), terminal]), move({ input: { value: 'ok' } }), {});
  expect(result.facts.answer).toBe('ok');
  expect(calls).toEqual(['outer-before', 'inner-before', 'terminal', 'inner-after', 'outer-after']);
});

test('reruns the suffix with a new request snapshot and transforms the response', async () => {
  const initial = move({ input: { value: 'broken' } });
  const requests: Request[] = [];
  const retry = defineStage<Request, Request, Response, Response>({
    name: 'retry',
    through: {
      request: { needs: ['input'], consumes: [], provides: ['input'] },
      response: { needs: ['answer'], consumes: [], provides: ['answer'] },
    },
    execute: async (facts, next) => {
      const first = await next(facts);
      if (first.answer !== 'fail') return first;
      const result = await next({ ...facts, input: move({ value: 'fixed' }) });
      return { ...result, answer: `${result.answer}:patched` };
    },
  });
  const terminal = defineStage<Request, Response>({
    name: 'terminal', return: { provides: ['answer'] },
    execute: async facts => {
      requests.push(facts);
      return move({ ...facts, answer: facts.input.value === 'broken' ? 'fail' : facts.input.value });
    },
  });
  const result = await run(compose<Request, Response>('retry', [retry, terminal]), initial, {});
  expect(result.facts.answer).toBe('fixed:patched');
  expect(requests.map(facts => facts.input.value)).toEqual(['broken', 'fixed']);
  expect(requests[0]).toBe(initial);
  expect(requests[1]).not.toBe(initial);
  expect(initial.input.value).toBe('broken');
  expect(requests.every(facts => Object.isFrozen(facts) && Object.isFrozen(facts.input))).toBe(true);
});

test('unwinds each enclosing finally and propagates the original error', async () => {
  const calls: string[] = [];
  const error = new Error('upstream failed');
  const wrap = (name: string) => defineStage<Request, Request, Response, Response>({
    name,
    through: {
      request: { needs: ['input'], consumes: [], provides: [] },
      response: { needs: ['answer'], consumes: [], provides: [] },
    },
    execute: async (facts, next) => {
      calls.push(`${name}-before`);
      try { return await next(facts); } finally { calls.push(`${name}-after`); }
    },
  });
  const terminal = defineStage<Request, Response>({
    name: 'terminal', return: { provides: ['answer'] }, execute: async () => { throw error; },
  });
  await expect(run(compose<Request, Response>('error', [wrap('outer'), wrap('inner'), terminal]), move({ input: { value: 'x' } }), {})).rejects.toBe(error);
  expect(calls).toEqual(['outer-before', 'inner-before', 'inner-after', 'outer-after']);
});
