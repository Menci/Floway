import { expect, test, vi } from 'vitest';

import { meteredStream, testCandidate } from './fixtures.ts';
import { computeUsage } from '../../../src/data-plane/pipeline/compute-usage.ts';
import { compose } from '../../../src/data-plane/pipeline/facts.ts';
import { measurePerformance } from '../../../src/data-plane/pipeline/performance.ts';
import { createGatewayServices } from '../../../src/data-plane/pipeline/services.ts';
import { storeUsage } from '../../../src/data-plane/pipeline/store-usage.ts';
import { tokenUsageMeasurement } from '../../../src/data-plane/shared/telemetry/usage.ts';
import { initRepo } from '../../../src/repo/index.ts';
import { generateServerSecret } from '../../../src/shared/server-secret.ts';
import { InMemoryRepo } from '../../repo/memory.ts';
import { run } from '@floway-dev/pipeline';

const performancePipeline = (ending: ReturnType<typeof meteredStream>, readUsageEarly = true) =>
  compose('performance-fixture', {
    entry: ['request.auth.apiKeyId', 'serve.runtimeLocation'],
    exit: ['response.usage', 'response.performance', 'response.http', 'response.openaiCompletions'],
    stages: [
      testCandidate,
      measurePerformance('openaiCompletions', 'chat', frame => frame.choices.some(choice => Boolean(choice.text))),
      storeUsage,
      computeUsage('openaiCompletions', {
        stream: () => ({
          frame: () => readUsageEarly ? [tokenUsageMeasurement({ output: 2 })] : undefined,
          done: () => [tokenUsageMeasurement({ output: 2 })],
        }),
      }),
    ],
    ending,
  });

test.each(['native done', 'panic'] as const)('stores authoritative stream usage before %s', async completion => {
  const repo = new InMemoryRepo();
  initRepo(repo);
  const services = await createGatewayServices('TEST', { id: 'key', serverSecret: generateServerSecret(), openaiResponsesRetentionSeconds: 0 });
  const release = Promise.withResolvers<void>();
  const detached: Promise<unknown>[] = [];
  const pipeline = performancePipeline(meteredStream({ release: release.promise }));
  const controller = new AbortController();
  const running = run(pipeline, {
    'request.auth.apiKeyId': 'key',
    'serve.runtimeLocation': 'TEST',
  }, {
    services,
    signal: controller.signal,
    waitUntil: work => { detached.push(work); },
  });
  const answer = await running.result;
  const outcome = answer['response.openaiCompletions'];
  if (outcome.kind !== 'stream') throw new Error('Expected the fixture stream');
  const reader = running.read(outcome.stream);
  expect((await reader.next()).done).toBe(false);
  expect(Object.hasOwn(answer, 'response.usageModelKey')).toBe(false);
  expect(await running.read(answer['response.usage'])).toMatchObject({ kind: 'observed', modelKey: 'native-fast-variant' });
  const measure = await running.read(answer['response.performance']);
  expect(measure.ttftMs).toBeGreaterThanOrEqual(20);
  await Promise.all(detached);
  expect(await repo.usage.listAll()).toMatchObject([{ upstream: 'upstream', modelKey: 'native-fast-variant', requests: 1 }]);
  expect(await repo.performance.listAll()).toEqual([]);
  if (completion === 'native done') {
    release.resolve();
    expect((await reader.next()).done).toBe(true);
    controller.abort();
    await running.done;
  } else {
    const defect = new Error('test panic after billing');
    release.reject(defect);
    await Promise.all([expect(reader.next()).rejects.toBe(defect), expect(running.done).rejects.toBe(defect)]);
    controller.abort(defect);
  }
  await Promise.all(detached);
  expect(await repo.usage.listAll()).toMatchObject([{ upstream: 'upstream', modelKey: 'native-fast-variant', requests: 1 }]);
  expect(await repo.performance.listAll()).toMatchObject(
    completion === 'native done' ? [{ upstream: 'upstream', requests: 1, ttftSamplesOk: 1 }] : [],
  );
});

test('records TPOT at stream completion while the usage write is pending', async () => {
  const repo = new InMemoryRepo();
  initRepo(repo);
  const services = await createGatewayServices('TEST', { id: 'key', serverSecret: generateServerSecret(), openaiResponsesRetentionSeconds: 0 });
  const release = Promise.withResolvers<void>();
  const usageStarted = Promise.withResolvers<void>();
  const releaseUsage = Promise.withResolvers<void>();
  const detached: Promise<unknown>[] = [];
  const recordUsage = repo.usage.record.bind(repo.usage);
  vi.spyOn(repo.usage, 'record').mockImplementation(async row => {
    usageStarted.resolve();
    await releaseUsage.promise;
    await recordUsage(row);
  });
  let time = 100;
  const clock = vi.spyOn(performance, 'now').mockImplementation(() => time);
  const controller = new AbortController();
  try {
    const running = run(performancePipeline(meteredStream({ release: release.promise })), {
      'request.auth.apiKeyId': 'key',
      'serve.runtimeLocation': 'TEST',
    }, {
      services,
      signal: controller.signal,
      waitUntil: work => { detached.push(work); },
    });
    const answer = await running.result;
    const outcome = answer['response.openaiCompletions'];
    if (outcome.kind !== 'stream') throw new Error('Expected the fixture stream');
    const reader = running.read(outcome.stream);
    expect((await reader.next()).done).toBe(false);
    await running.read(answer['response.usage']);
    await usageStarted.promise;
    expect(await running.read(answer['response.performance'])).toEqual({ ttftMs: 20 });
    expect(await repo.usage.listAll()).toEqual([]);
    expect(await repo.performance.listAll()).toEqual([]);

    time = 140;
    release.resolve();
    expect((await reader.next()).done).toBe(true);
    await running.done;
    time = 1_000;
    await vi.waitFor(async () => expect(await repo.performance.listAll()).toMatchObject([
      { requests: 1, tpotSamples: 1, tpotUsSum: 40_000 },
    ]));
    expect(await repo.usage.listAll()).toEqual([]);
  } finally {
    release.resolve();
    releaseUsage.resolve();
    controller.abort();
    clock.mockRestore();
    await Promise.all(detached);
  }
  expect(await repo.usage.listAll()).toMatchObject([{ modelKey: 'native-fast-variant', requests: 1 }]);
});

test('stream abort before usage is local and writes neither usage nor performance', async () => {
  const repo = new InMemoryRepo();
  initRepo(repo);
  const services = await createGatewayServices('TEST', { id: 'key', serverSecret: generateServerSecret(), openaiResponsesRetentionSeconds: 0 });
  const cause = new Error('local cancellation before usage');
  const controller = new AbortController();
  const detached: Promise<unknown>[] = [];
  const ending = meteredStream({ failure: { kind: 'abort', cause } });
  const running = run(performancePipeline(ending, false), {
    'request.auth.apiKeyId': 'key',
    'serve.runtimeLocation': 'TEST',
  }, {
    services,
    signal: controller.signal,
    waitUntil: work => { detached.push(work); },
  });
  const answer = await running.result;
  const outcome = answer['response.openaiCompletions'];
  if (outcome.kind !== 'stream') throw new Error('Expected the fixture stream');
  const reader = running.read(outcome.stream);
  expect((await reader.next()).value).toMatchObject({ ok: true });
  expect((await reader.next()).value).toMatchObject({ ok: false, error: { kind: 'abort', cause } });
  expect((await reader.next()).done).toBe(true);
  expect(await running.read(answer['response.usage'])).toEqual({ kind: 'local' });
  await running.read(answer['response.performance']);
  controller.abort(cause);
  await running.done;
  await Promise.all(detached);
  expect(await repo.usage.listAll()).toEqual([]);
  expect(await repo.performance.listAll()).toEqual([]);
});
