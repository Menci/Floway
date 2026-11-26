import { expect, test } from 'vitest';

import { compose, defineStage, type Candidate } from '../../../src/data-plane/pipeline/facts.ts';
import { failover } from '../../../src/data-plane/pipeline/failover.ts';
import { createGatewayServices } from '../../../src/data-plane/pipeline/services.ts';
import { initRepo } from '../../../src/repo/index.ts';
import { generateServerSecret } from '../../../src/shared/server-secret.ts';
import { InMemoryRepo } from '../../repo/memory.ts';
import { run } from '@floway-dev/pipeline';
import { toProviderModelFact } from '@floway-dev/provider';
import { stubProviderModel } from '@floway-dev/test-utils';

const candidate = (id: string): Candidate => ({
  upstream: { id, kind: 'custom', name: id, config: {} },
  model: toProviderModelFact(stubProviderModel()),
});

test('failover aborts the losing child before retry and discards both its held handles', async () => {
  initRepo(new InMemoryRepo());
  const services = await createGatewayServices('TEST', { id: 'key', serverSecret: generateServerSecret(), openaiResponsesRetentionSeconds: 0 });
  const abort = Promise.withResolvers<void>();
  const drained = Promise.withResolvers<void>();
  const settled = Promise.withResolvers<void>();
  const ending = defineStage({
    name: 'embeddings-fixture',
    request: { needs: ['provider.upstream'] },
    return: { provides: ['response.http', 'response.openaiEmbeddings', 'response.usage?'] },
    async execute(facts, scope) {
      if (facts['provider.upstream'].id === 'first') {
        scope.signal.addEventListener('abort', () => abort.resolve(), { once: true });
        const body = scope.createStream<Uint8Array, never>(async function* () {
          yield { ok: true, value: new Uint8Array([1]) };
          await abort.promise;
          drained.resolve();
        });
        const usage = scope.createDeferred(async () => {
          await abort.promise;
          settled.resolve();
          return { kind: 'upstream-error' as const };
        });
        return {
          'response.http': { status: 400, statusText: '', headers: [], body },
          'response.openaiEmbeddings': { kind: 'error', source: 'upstream', error: { message: 'first failed' } },
          'response.usage': usage,
        };
      }
      await abort.promise;
      return {
        'response.http': { status: 200, statusText: '', headers: [], body: null },
        'response.openaiEmbeddings': { kind: 'result', result: { data: [] } },
      };
    },
  });
  const pipeline = compose('embeddings-failover-fixture', {
    entry: ['request.candidates'],
    exit: ['response.http', 'response.openaiEmbeddings', 'response.candidate', 'response.usage?'],
    stages: [failover('openaiEmbeddings')],
    ending,
  });
  const running = run(pipeline, { 'request.candidates': [candidate('first'), candidate('second')] }, {
    services,
    signal: new AbortController().signal,
    waitUntil() {},
  });
  const answer = await running.result;
  expect(answer['response.candidate'].upstreamId).toBe('second');
  await Promise.all([running.done, drained.promise, settled.promise]);
});
