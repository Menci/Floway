import { test } from 'vitest';

import { type Interceptor, runInterceptors } from '../src/index.ts';
import { assertEquals, assertRejects } from '@floway-dev/test-utils';

type TestCtx = { payload: { value: string } };
type TestEnv = { traceId: string };

test('composes interceptors outermost-first and unwinds epilogues inside-out', async () => {
  const calls: string[] = [];

  const outer: Interceptor<TestCtx, TestEnv, string> = async (_ctx, _env, run) => {
    calls.push('outer-before');
    const result = await run();
    calls.push('outer-after');
    return result;
  };
  const inner: Interceptor<TestCtx, TestEnv, string> = async (_ctx, _env, run) => {
    calls.push('inner-before');
    const result = await run();
    calls.push('inner-after');
    return result;
  };

  await runInterceptors({ payload: { value: 'ok' } }, { traceId: 't' }, [outer, inner], () => {
    calls.push('terminal');
    return Promise.resolve('done');
  });

  assertEquals(calls, ['outer-before', 'inner-before', 'terminal', 'inner-after', 'outer-after']);
});

test('lets an interceptor retry by calling run() again — each call reruns the inner chain', async () => {
  const ctx: TestCtx = { payload: { value: 'broken' } };
  let attempts = 0;

  const interceptor: Interceptor<TestCtx, TestEnv, string> = async (current, _env, run) => {
    const first = await run();
    if (first !== 'fail') return first;
    current.payload.value = 'fixed';
    return await run();
  };

  const result = await runInterceptors(ctx, { traceId: 't' }, [interceptor], () => {
    attempts += 1;
    return Promise.resolve(ctx.payload.value === 'broken' ? 'fail' : ctx.payload.value);
  });

  assertEquals(attempts, 2);
  assertEquals(result, 'fixed');
});

test('propagates an inner throw past each enclosing run() call site without swallowing', async () => {
  const seen: string[] = [];

  const wrap = (label: string): Interceptor<TestCtx, TestEnv, string> => async (_ctx, _env, run) => {
    seen.push(`${label}-before`);
    try {
      return await run();
    } finally {
      seen.push(`${label}-after`);
    }
  };

  const boom = new Error('upstream blew up');
  await assertRejects(
    () => runInterceptors({ payload: { value: 'x' } }, { traceId: 't' }, [wrap('outer'), wrap('inner')], () => Promise.reject(boom)),
    Error,
    'upstream blew up',
  );

  assertEquals(seen, ['outer-before', 'inner-before', 'inner-after', 'outer-after']);
});

test('lets an interceptor patch context before run and transform the result after run', async () => {
  const ctx: TestCtx = { payload: { value: 'original' } };

  const interceptor: Interceptor<TestCtx, TestEnv, string> = async (current, _env, run) => {
    current.payload.value = 'patched';
    const result = await run();
    return `${result}:${current.payload.value}`;
  };

  const result = await runInterceptors(ctx, { traceId: 't' }, [interceptor], () => Promise.resolve(ctx.payload.value));

  assertEquals(ctx.payload.value, 'patched');
  assertEquals(result, 'patched:patched');
});
