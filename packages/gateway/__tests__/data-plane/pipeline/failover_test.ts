import { expect, test } from 'vitest';

import { gatewayFactSpace, type ServeCandidate } from '../../../src/data-plane/pipeline/facts.ts';
import { failover } from '../../../src/data-plane/pipeline/failover.ts';
import { providerSupportsOperation } from '../../../src/data-plane/pipeline/provider-pipelines.ts';
import { responseHead } from '../../../src/data-plane/pipeline/response.ts';
import { getHeader, type HttpStreamError } from '@floway-dev/http';
import { move, run, type Result } from '@floway-dev/pipeline';

const { compose, defineStage } = gatewayFactSpace<{}>();
const responseKey = 'response.openaiEmbeddings';

const candidate = (id: string): ServeCandidate => ({
  upstream: { id, kind: 'custom', name: id, config: {} },
  model: {
    id: 'public-model',
    kind: 'embedding',
    upstreamModelId: 'target-model',
    limits: {},
    endpoints: { openaiEmbeddings: {} },
    opaqueBlobCompatibilityScope: { bindToUpstream: false },
    enabledFlags: [],
  },
});

const entryFacts = (ids: readonly string[]) => ({
  'serve.model': 'public-model',
  'serve.candidates': move({ candidates: ids.map(candidate), sawModel: true, failedUpstreams: [] }),
});

const choose = failover(responseKey, () => {
  throw new Error('Expected at least one test candidate');
}, () => true);

test('failover retains the earliest retry response across later transport failures', async () => {
  const calls: string[] = [];
  const ending = defineStage({
    name: 'test.return-failure',
    request: { needs: ['serve.candidate'] },
    return: { provides: ['response.http', responseKey] },
    async execute(facts) {
      const { id } = facts['serve.candidate'].upstream;
      calls.push(id);
      const http = id === 'transport' ? null : { ...responseHead(429), headers: [['retry-after', id]] as [string, string][] };
      return {
        'response.http': move(http),
        [responseKey]: move({ kind: 'error', source: 'upstream', error: { id } }),
      };
    },
  });
  const pipeline = compose('test.failure-selection', {
    entry: ['serve.model', 'serve.candidates'], exit: ['response.http', responseKey], stages: [choose], ending,
  });

  const handle = run(pipeline, entryFacts(['20', '1', '10', 'transport']), { services: {} });
  const answer = await handle.result;
  expect(calls).toEqual(['20', '1', '10', 'transport']);
  expect(answer[responseKey]).toEqual({ kind: 'error', source: 'upstream', error: { id: '1' } });
  expect(getHeader(answer['response.http']!.headers, 'retry-after')).toBe('1');
  await handle.done;
});

test('failover aborts the losing child, awaits its native completion, and stops after success', async () => {
  const calls: string[] = [];
  const aborted = Promise.withResolvers<void>();
  const allowNativeDone = Promise.withResolvers<void>();
  let drained = false;
  const ending = defineStage({
    name: 'test.return-live-failure',
    request: { needs: ['serve.candidate'] },
    return: { provides: ['response.http', responseKey] },
    async execute(facts, scope) {
      const { id } = facts['serve.candidate'].upstream;
      calls.push(id);
      if (id === 'winner') return {
        'response.http': move(responseHead(200)),
        [responseKey]: move({ kind: 'result', result: { id } }),
      };
      const body = scope.createStream(async function* ({ signal }): AsyncIterable<Result<Uint8Array, HttpStreamError>> {
        expect(signal.aborted).toBe(true);
        aborted.resolve();
        yield { ok: false, error: { kind: 'abort', cause: signal.reason } };
        await allowNativeDone.promise;
        drained = true;
      });
      return {
        'response.http': move({ ...responseHead(400), body }),
        [responseKey]: move({ kind: 'error', source: 'upstream', error: { id } }),
      };
    },
  });
  const pipeline = compose('test.live-failure-selection', {
    entry: ['serve.model', 'serve.candidates'], exit: ['response.http', responseKey], stages: [choose], ending,
  });

  const handle = run(pipeline, entryFacts(['loser', 'winner', 'unused']), { services: {} });
  let returned = false;
  const answer = handle.result.then(value => { returned = true; return value; });
  try {
    await Promise.race([
      aborted.promise,
      answer.then(() => { throw new Error('Failover answered before aborting the losing child'); }),
    ]);
    expect(returned).toBe(false);
    expect(calls).toEqual(['loser', 'winner']);
  } finally {
    allowNativeDone.resolve();
  }
  expect((await answer)[responseKey]).toEqual({ kind: 'result', result: { id: 'winner' } });
  await handle.done;
  expect(drained).toBe(true);
});

test('failover skips providers without a handle for the discovered operation', async () => {
  const calls: string[] = [];
  const wrongKind = candidate('wrong-kind');
  const unsupported: ServeCandidate = { ...wrongKind, upstream: { ...wrongKind.upstream, kind: 'claude-code' } };
  const ending = defineStage({
    name: 'test.return-supported-result',
    request: { needs: ['serve.candidate'] },
    return: { provides: ['response.http', responseKey] },
    async execute(facts) {
      const { id } = facts['serve.candidate'].upstream;
      calls.push(id);
      return {
        'response.http': move(responseHead(200)),
        [responseKey]: move({ kind: 'result', result: { id } }),
      };
    },
  });
  const select = failover(responseKey, () => { throw new Error('Expected the supported candidate'); },
    item => providerSupportsOperation(item.upstream.kind, 'openaiEmbeddings'));
  const pipeline = compose('test.operation-selection', {
    entry: ['serve.model', 'serve.candidates'], exit: ['response.http', responseKey], stages: [select], ending,
  });
  const handle = run(pipeline, {
    'serve.model': 'public-model',
    'serve.candidates': move({
      candidates: [unsupported, candidate('supported')],
      sawModel: true,
      failedUpstreams: [],
    }),
  }, { services: {} });
  expect((await handle.result)[responseKey]).toEqual({ kind: 'result', result: { id: 'supported' } });
  expect(calls).toEqual(['supported']);
  await handle.done;
});
