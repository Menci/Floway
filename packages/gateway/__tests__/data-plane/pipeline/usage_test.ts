import { expect, test } from 'vitest';

import { testCandidate } from './fixtures.ts';
import { computeUsage } from '../../../src/data-plane/pipeline/compute-usage.ts';
import { compose, defineStage, type GatewayPipelineFacts } from '../../../src/data-plane/pipeline/facts.ts';
import { createGatewayServices } from '../../../src/data-plane/pipeline/services.ts';
import { storeUsage } from '../../../src/data-plane/pipeline/store-usage.ts';
import { requestOnlyUsageMeasurement } from '../../../src/data-plane/shared/telemetry/usage.ts';
import { initRepo } from '../../../src/repo/index.ts';
import { generateServerSecret } from '../../../src/shared/server-secret.ts';
import { InMemoryRepo } from '../../repo/memory.ts';
import { run } from '@floway-dev/pipeline';

const settleEmbeddings = async (outcome: GatewayPipelineFacts['response.openaiEmbeddings'], modelKey?: string) => {
  const repo = new InMemoryRepo();
  initRepo(repo);
  const services = await createGatewayServices('TEST', { id: 'key', serverSecret: generateServerSecret(), openaiResponsesRetentionSeconds: 0 });
  const ending = defineStage({
    name: 'embeddings-usage-fixture',
    request: { needs: [] },
    return: { provides: ['response.openaiEmbeddings', 'response.usageModelKey?'] },
    async execute() {
      return {
        'response.openaiEmbeddings': outcome,
        ...(modelKey === undefined ? {} : { 'response.usageModelKey': modelKey }),
      };
    },
  });
  const pipeline = compose('embeddings-usage-settlement', {
    entry: ['request.auth.apiKeyId'],
    exit: ['response.openaiEmbeddings', 'response.usage'],
    stages: [testCandidate, storeUsage, computeUsage('openaiEmbeddings', { result: () => [requestOnlyUsageMeasurement()] })],
    ending,
  });
  const controller = new AbortController();
  const detached: Promise<unknown>[] = [];
  const running = run(pipeline, { 'request.auth.apiKeyId': 'key' }, {
    services,
    signal: controller.signal,
    waitUntil: work => { detached.push(work); },
  });
  return { running, controller, detached, repo };
};

test('stores the dispatched model variant and consumes the provider usage fact', async () => {
  const { running, controller, detached, repo } = await settleEmbeddings({ kind: 'result', result: {} }, 'wire-embedding-variant');
  const answer = await running.result;
  expect(Object.hasOwn(answer, 'response.usageModelKey')).toBe(false);
  expect(await running.read(answer['response.usage'])).toMatchObject({ kind: 'observed', modelKey: 'wire-embedding-variant' });
  controller.abort();
  await running.done;
  await Promise.all(detached);
  expect(await repo.usage.listAll()).toMatchObject([{ model: 'test-model', modelKey: 'wire-embedding-variant' }]);
});

test('local outcomes do not need a dispatched model or create a usage row', async () => {
  const { running, controller, detached, repo } = await settleEmbeddings({ kind: 'error', source: 'local', error: { message: 'invalid' } });
  const answer = await running.result;
  expect(await running.read(answer['response.usage'])).toEqual({ kind: 'local' });
  controller.abort();
  await running.done;
  await Promise.all(detached);
  expect(await repo.usage.listAll()).toEqual([]);
});

test('billable usage without a dispatched model key panics', async () => {
  const { running, controller, detached, repo } = await settleEmbeddings({ kind: 'result', result: {} });
  await Promise.all([
    expect(running.result).rejects.toThrow('provider returned billable usage without a dispatched model key'),
    expect(running.done).rejects.toThrow('provider returned billable usage without a dispatched model key'),
  ]);
  controller.abort();
  await Promise.all(detached);
  expect(await repo.usage.listAll()).toEqual([]);
});
