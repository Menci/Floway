import { expect, test, vi } from 'vitest';

import { candidateFor, hostFor } from './fixtures.ts';
import { observeUsage, type UsageObservation } from '../../../src/data-plane/pipeline/compute-usage.ts';
import type { Candidate } from '../../../src/data-plane/pipeline/facts.ts';
import { observePerformance } from '../../../src/data-plane/pipeline/performance.ts';
import type { GatewayServices } from '../../../src/data-plane/pipeline/services.ts';
import { storeUsage } from '../../../src/data-plane/pipeline/store-usage.ts';
import { requestOnlyUsageMeasurement, tokenUsageMeasurement } from '../../../src/data-plane/shared/telemetry/usage.ts';
import type { HttpResponseFact } from '@floway-dev/http';
import { asEntry, factSpace, run, type Deferred, type Result } from '@floway-dev/pipeline';
import type { ProtocolError, ProtocolOutcome, ProtocolStreamError } from '@floway-dev/upstream';

type Frame = 'token' | 'usage';
type Request = Pick<Candidate, 'upstream' | 'model'>;
type Response = {
  operation: ProtocolOutcome<Frame, number | null>;
  http: HttpResponseFact | null;
  usage: Deferred<UsageObservation>;
};
type Services = Pick<GatewayServices, 'recordUsage' | 'recordPerformance'>;
type Body = () => AsyncGenerator<Result<Frame, ProtocolStreamError>, void, unknown>;

const measureTokens = () => tokenUsageMeasurement({ output: 2 });
const { defineStage, compose } = factSpace<Request, Response, Services>();

const computeUsage = defineStage({
  name: 'compute-test-usage',
  through: {
    request: { needs: ['model'], provides: [], consumes: [] },
    response: { needs: ['operation'], provides: ['operation', 'usage'], consumes: [] },
  },
  async execute(facts, scope) {
    const answer = await scope.next(facts);
    const { outcome: operation, usage } = observeUsage(scope, answer.operation, facts.model.upstreamModelId, {
      result: value => [value === null ? requestOnlyUsageMeasurement() : tokenUsageMeasurement({ output: value })],
      stream: () => ({
        frame: frame => frame === 'usage' ? [measureTokens()] : undefined,
        done: () => [requestOnlyUsageMeasurement()],
      }),
    });
    return { ...answer, operation, usage };
  },
});

const measurePerformance = defineStage({
  name: 'measure-test-performance',
  through: {
    request: { needs: ['upstream', 'model'], provides: [], consumes: [] },
    response: { needs: ['operation', 'http', 'usage'], provides: ['operation', 'usage'], consumes: [] },
  },
  async execute(facts, scope) {
    const answer = await scope.next(facts);
    const { outcome: operation, usage } = observePerformance(scope, answer.operation, answer.usage, {
      upstream: facts.upstream.id,
      model: facts.model.id,
      operation: 'chat',
      startedAt: answer.http?.startedAt,
      isFirstOutput: frame => frame === 'token',
    });
    return { ...answer, operation, usage };
  },
});

const dispatch = (result: Body | ProtocolError | number | null) => {
  const recordUsage = vi.fn<Services['recordUsage']>(async () => {});
  const recordPerformance = vi.fn<Services['recordPerformance']>(async () => {});
  const host = hostFor({ recordUsage, recordPerformance });
  const ending = defineStage({
    name: 'upstream', request: { needs: [] }, return: { provides: ['operation', 'http'] },
    async execute(_facts, scope) {
      if (result !== null && typeof result === 'object') return { http: null, operation: result };
      return {
        http: { status: 200, statusText: '', headers: [], body: null, startedAt: performance.now() - 20 },
        operation: typeof result === 'function'
          ? { kind: 'stream', stream: scope.createStream(result) }
          : { kind: 'result', result },
      };
    },
  });
  const entry = asEntry(compose('meter-call', {
    entry: ['model', 'upstream'],
    exit: ['http', 'operation', 'usage'],
    stages: [measurePerformance, storeUsage, computeUsage],
    ending,
  }));
  const { model, upstream } = candidateFor('metered');
  const running = run(entry, { model, upstream }, host.options);
  return { host, running, recordUsage, recordPerformance };
};

test.each([
  { value: null, reported: false },
  { value: 0, reported: true },
])('records a scalar billable call with report state $reported', async ({ value, reported }) => {
  const { host, running, recordUsage, recordPerformance } = dispatch(value);
  const answer = await running.result;
  const usage = await running.read(answer.usage);
  expect(usage).toEqual({
    kind: 'observed', modelKey: 'wire-model',
    usage: reported
      ? [{ reported, quantities: { output_tokens: '0' }, pricingFacts: { inputTokens: 0, serviceTier: undefined } }]
      : [{ reported, quantities: {}, pricingFacts: {} }],
  });
  host.controller.abort();
  running.discard(answer);
  await host.settle();
  expect(recordUsage).toHaveBeenCalledWith(
    { model: 'public-model', modelKey: 'wire-model', pricing: null, upstream: 'metered' },
    expect.objectContaining({ reported }),
  );
  expect(recordPerformance).toHaveBeenCalledWith({ operation: 'chat', model: 'public-model', upstream: 'metered', failed: false, ttftMs: null });
});

test('stores observed usage while stream delivery and storage continue independently', async () => {
  const finishStream = Promise.withResolvers<void>();
  const finishStorage = Promise.withResolvers<void>();
  const storageFailure = new Error('background write failed');
  const { host, running, recordUsage, recordPerformance } = dispatch(async function* () {
    yield { ok: true, value: 'token' };
    yield { ok: true, value: 'usage' };
    await finishStream.promise;
  });
  recordUsage.mockReturnValueOnce(finishStorage.promise);
  const answer = await running.result;
  if (answer.operation.kind !== 'stream') throw new Error('Expected upstream stream');
  const frames = running.read(answer.operation.stream);
  await expect(frames.next()).resolves.toMatchObject({ value: { ok: true, value: 'token' } });
  await expect(frames.next()).resolves.toMatchObject({ value: { ok: true, value: 'usage' } });
  await expect(running.read(answer.usage)).resolves.toMatchObject({ kind: 'observed' });
  expect(recordUsage).toHaveBeenCalledOnce();
  expect(recordPerformance).not.toHaveBeenCalled();

  finishStream.resolve();
  await expect(frames.next()).resolves.toMatchObject({ done: true });
  await vi.waitFor(() => expect(recordPerformance).toHaveBeenCalledOnce());
  host.controller.abort();
  running.discard(answer);
  finishStorage.reject(storageFailure);
  await host.settle();
  expect(host.errors).toEqual([storageFailure]);
  expect(recordPerformance).toHaveBeenCalledOnce();
  const sample = recordPerformance.mock.calls[0]![0];
  expect(sample).toMatchObject({ failed: false, operation: 'chat' });
  expect(sample.ttftMs).toBeGreaterThanOrEqual(20);
  expect(sample.tpotUs).toBeGreaterThanOrEqual(0);
});

test.each([
  { kind: 'transport' as const, observation: 'upstream-error', counted: true },
  { kind: 'abort' as const, observation: 'local', counted: false },
])('classifies a stream $kind by its Err', async ({ kind, observation, counted }) => {
  const cause = new Error('I/O ended');
  const { host, running, recordUsage, recordPerformance } = dispatch(async function* () {
    yield { ok: false, error: { kind, cause } };
  });
  const answer = await running.result;
  if (answer.operation.kind !== 'stream') throw new Error('Expected upstream stream');
  const frames = running.read(answer.operation.stream);
  const item = await frames.next();
  expect(item.value).toEqual({ ok: false, error: { kind, cause } });
  expect(item.value && !item.value.ok && item.value.error.cause).toBe(cause);
  await expect(frames.next()).resolves.toMatchObject({ done: true });
  await expect(running.read(answer.usage)).resolves.toEqual({ kind: observation });
  host.controller.abort();
  running.discard(answer);
  await host.settle();
  expect(recordUsage).not.toHaveBeenCalled();
  expect(recordPerformance).toHaveBeenCalledTimes(counted ? 1 : 0);
  if (counted) expect(recordPerformance).toHaveBeenCalledWith({ operation: 'chat', model: 'public-model', upstream: 'metered', failed: true, ttftMs: null });
});

test('records billable usage, TTFT and TPOT for a stream that fails after output', async () => {
  const now = vi.spyOn(performance, 'now').mockReturnValue(120);
  try {
    const { host, running, recordUsage, recordPerformance } = dispatch(async function* () {
      yield { ok: true, value: 'token' };
      yield { ok: true, value: 'usage' };
      yield { ok: false, error: { kind: 'transport', cause: new Error('partial result') } };
    });
    const answer = await running.result;
    if (answer.operation.kind !== 'stream') throw new Error('Expected upstream stream');
    expect(answer.http?.startedAt).toBe(100);
    const frames = running.read(answer.operation.stream);
    now.mockReturnValue(500);
    await frames.next();
    await frames.next();
    now.mockReturnValue(1_000);
    await expect(frames.next()).resolves.toMatchObject({ value: { ok: false, error: { kind: 'transport' } } });
    await expect(frames.next()).resolves.toMatchObject({ done: true });
    const usage = await running.read(answer.usage);
    expect(usage).toMatchObject({ kind: 'observed', usage: [{ reported: true, quantities: { output_tokens: '2' } }] });
    host.controller.abort();
    running.discard(answer);
    await host.settle();
    expect(recordUsage).toHaveBeenCalledOnce();
    expect(recordPerformance.mock.calls).toEqual([[
      { operation: 'chat', model: 'public-model', upstream: 'metered', failed: true, ttftMs: 400, tpotUs: 500_000 },
    ]]);
  } finally {
    now.mockRestore();
  }
});

test('a negative output token count rejects the performance worker with its original diagnostic', async () => {
  const { host, running, recordPerformance } = dispatch(-1);
  const answer = await running.result;
  await expect(running.read(answer.usage)).resolves.toMatchObject({
    kind: 'observed', usage: [{ quantities: { output_tokens: '-1' } }],
  });
  host.controller.abort();
  running.discard(answer);
  await host.settle();
  expect(recordPerformance).not.toHaveBeenCalled();
  expect(host.errors).toEqual([expect.objectContaining({ name: 'RangeError', message: 'Negative output token count: -1' })]);
});

test.each([
  { source: 'upstream' as const, observation: 'upstream-error', counted: true },
  { source: 'local' as const, observation: 'local', counted: false },
])('classifies a scalar $source error by its source', async ({ source, observation, counted }) => {
  const { host, running, recordUsage, recordPerformance } = dispatch({ kind: 'error', source, error: { error: 'failure' } });
  const answer = await running.result;
  await expect(running.read(answer.usage)).resolves.toEqual({ kind: observation });
  host.controller.abort();
  running.discard(answer);
  await host.settle();
  expect(recordUsage).not.toHaveBeenCalled();
  expect(recordPerformance).toHaveBeenCalledTimes(counted ? 1 : 0);
});

test.each([false, true])('propagates the original stream panic after a billable observation: %s', async observed => {
  const panic = new RangeError('interceptor bug');
  const { host, running, recordUsage, recordPerformance } = dispatch(async function* () {
    if (observed) yield { ok: true, value: 'usage' };
    throw panic;
  });
  const answer = await running.result;
  if (answer.operation.kind !== 'stream') throw new Error('Expected upstream stream');
  const frames = running.read(answer.operation.stream);
  if (observed) await frames.next();
  await expect(frames.next()).rejects.toBe(panic);
  const usage = running.read(answer.usage);
  if (observed) await expect(usage).resolves.toMatchObject({ kind: 'observed' });
  else await expect(usage).rejects.toBe(panic);
  host.controller.abort();
  running.discard(answer);
  await host.settle();
  expect(recordUsage).toHaveBeenCalledTimes(observed ? 1 : 0);
  expect(recordPerformance).not.toHaveBeenCalled();
  expect(host.errors).toEqual([]);
});
