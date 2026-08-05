import { expect, test, vi } from 'vitest';

import { type Interceptor, runInterceptors } from '../src/index.ts';

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

  expect(calls).toEqual(['outer-before', 'inner-before', 'terminal', 'inner-after', 'outer-after']);
});

test('runs a synchronously throwing terminal through the asynchronous empty-chain boundary', async () => {
  const boom = new Error('terminal failed synchronously');
  const terminal = vi.fn((): Promise<string> => { throw boom; });

  const promise = runInterceptors({ payload: { value: 'ok' } }, { traceId: 't' }, [], terminal);

  await expect(promise).rejects.toBe(boom);
  expect(terminal).toHaveBeenCalledOnce();
});

test('lets an interceptor retry by calling run() again — each call reruns the inner chain', async () => {
  const ctx: TestCtx = { payload: { value: 'broken' } };
  let attempts = 0;
  const innerValues: string[] = [];

  const retry: Interceptor<TestCtx, TestEnv, string> = async (current, _env, run) => {
    const first = await run();
    if (first !== 'fail') return first;
    current.payload.value = 'fixed';
    return await run();
  };
  const inner: Interceptor<TestCtx, TestEnv, string> = async (current, _env, run) => {
    innerValues.push(current.payload.value);
    return await run();
  };

  const result = await runInterceptors(ctx, { traceId: 't' }, [retry, inner], () => {
    attempts += 1;
    return Promise.resolve(ctx.payload.value === 'broken' ? 'fail' : ctx.payload.value);
  });

  expect(attempts).toBe(2);
  expect(innerValues).toEqual(['broken', 'fixed']);
  expect(result).toBe('fixed');
});

test('runs concurrent continuations independently through the complete downstream chain', async () => {
  let innerRuns = 0;
  let terminalRuns = 0;
  const fanOut: Interceptor<TestCtx, TestEnv, number> = async (_ctx, _env, run) => {
    const results = await Promise.all([run(), run()]);
    return results[0] + results[1];
  };
  const inner: Interceptor<TestCtx, TestEnv, number> = async (_ctx, _env, run) => {
    innerRuns += 1;
    return await run();
  };

  const result = await runInterceptors({ payload: { value: 'x' } }, { traceId: 't' }, [fanOut, inner], () =>
    Promise.resolve(++terminalRuns));

  expect(result).toBe(3);
  expect(innerRuns).toBe(2);
  expect(terminalRuns).toBe(2);
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
  await expect(runInterceptors(
    { payload: { value: 'x' } },
    { traceId: 't' },
    [wrap('outer'), wrap('inner')],
    () => Promise.reject(boom),
  )).rejects.toBe(boom);

  expect(seen).toEqual(['outer-before', 'inner-before', 'inner-after', 'outer-after']);
});

test('passes the original context and environment through one-way mutation and result transforms', async () => {
  const ctx: TestCtx = { payload: { value: 'original' } };
  const env: TestEnv = { traceId: 'original-trace' };

  const interceptor: Interceptor<TestCtx, TestEnv, string> = async (current, ambient, run) => {
    expect(current).toBe(ctx);
    expect(ambient).toBe(env);
    current.payload.value = 'patched';
    ambient.traceId = 'patched-trace';
    const result = await run();
    return `${result}:${current.payload.value}:${ambient.traceId}`;
  };

  const result = await runInterceptors(ctx, env, [interceptor], () =>
    Promise.resolve(`${ctx.payload.value}:${env.traceId}`));

  expect(ctx.payload.value).toBe('patched');
  expect(env.traceId).toBe('patched-trace');
  expect(result).toBe('patched:patched-trace:patched:patched-trace');
});

test('retains a short-circuited continuation over the invocation\'s original chain', async () => {
  let continuation: (() => Promise<string>) | undefined;
  const calls: string[] = [];
  const capture: Interceptor<TestCtx, TestEnv, string> = async (_ctx, _env, run) => {
    continuation = run;
    return 'deferred';
  };
  const originalInner: Interceptor<TestCtx, TestEnv, string> = async (_ctx, _env, run) => {
    calls.push('original-inner');
    return await run();
  };
  const replacementInner: Interceptor<TestCtx, TestEnv, string> = async (_ctx, _env, run) => {
    calls.push('replacement-inner');
    return await run();
  };
  const chain = [capture, originalInner];

  const initial = await runInterceptors({ payload: { value: 'x' } }, { traceId: 't' }, chain, async () => {
    calls.push('terminal');
    return 'done';
  });
  chain[1] = replacementInner;

  expect(initial).toBe('deferred');
  expect(calls).toEqual([]);
  expect(continuation).toBeDefined();
  expect(await continuation!()).toBe('done');
  expect(calls).toEqual(['original-inner', 'terminal']);
});

test('handles long eager chains without exhausting the JavaScript call stack', async () => {
  const chainLength = 10_000;
  let visits = 0;
  const passthrough: Interceptor<TestCtx, TestEnv, number> = async (_ctx, _env, run) => {
    visits += 1;
    return await run();
  };

  const result = await runInterceptors(
    { payload: { value: 'x' } },
    { traceId: 't' },
    Array.from({ length: chainLength }, () => passthrough),
    () => Promise.resolve(42),
  );

  expect(visits).toBe(chainLength);
  expect(result).toBe(42);
});
