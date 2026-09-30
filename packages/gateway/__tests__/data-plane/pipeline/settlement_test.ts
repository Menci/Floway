import { describe, expect, it, vi } from 'vitest';

import type { GatewayFacts } from '../../../src/data-plane/pipeline/facts.ts';
import { failover } from '../../../src/data-plane/pipeline/failover.ts';
import { settleBillable, writeSettlement } from '../../../src/data-plane/pipeline/settlement.ts';
import { initDumpBroker, initDumpStore } from '../../../src/dump/registry.ts';
import { openRunDump } from '../../../src/dump/run-sink.ts';
import { initRepo } from '../../../src/repo/index.ts';
import { installDumpStubs, runRecordOf } from '../../dump/test-fixtures.ts';
import { InMemoryRepo } from '../../repo/memory.ts';
import { mockGatewayCtx } from '../../test-utils/gateway-ctx.ts';
import { compose, defineStage, move, run } from '@floway-dev/pipeline';
import { mockPerfTelemetryContext } from '@floway-dev/test-utils';

describe('pipeline settlement', () => {
  it.each([false, true])('keeps call rows, totals and output performance on failed=%s', async failed => {
    const repo = new InMemoryRepo();
    initRepo(repo);
    const stubs = installDumpStubs(initDumpStore, initDumpBroker);
    const pending: Promise<unknown>[] = [];
    const background = (work: Promise<unknown>) => { pending.push(work); };
    const key = {
      id: 'key_test', userId: 1, name: 'Test key', key: 'raw-key', serverSecret: '11'.repeat(32),
      createdAt: '2026-01-01T00:00:00.000Z', upstreamIds: null, deletedAt: null,
      dumpRetentionSeconds: 3600, openaiResponsesRetentionSeconds: 0,
    };
    const recordUsage = vi.spyOn(repo.usage, 'record');
    const timing = { upstreamCallStartedAt: 50, firstOutputTokenAt: 100 };
    const dump = openRunDump(key, {
      method: 'POST', path: '/v1/responses', body: { bytes: new Uint8Array(), streamError: null },
    }, background, true, timing);
    const gateway = mockGatewayCtx({
      dump, backgroundScheduler: background,
      attempt: { timing, telemetry: mockPerfTelemetryContext({ keyId: key.id }) },
    });
    const identity = { model: 'm', upstream: 'u', modelKey: 'm', pricing: null };
    if (failed) dump!.failed(new Error('Original source failure', { cause: new Error('socket reset') }));
    const active = pending.length;
    settleBillable({ gateway, background, log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} } }, [
      { identity, quantities: { input_tokens: '10', output_tokens: '2' } },
      { identity, quantities: { input_tokens: '20', output_tokens: '3' } },
    ], failed, 500);
    await Promise.all(pending.slice(active));
    const usage = await repo.usage.listAll();
    expect(recordUsage.mock.calls.map(([row]) => row.metrics.map(metric => metric.quantity))).toEqual([['10', '2'], ['20', '3']]);
    expect(usage).toMatchObject([{ requests: 2 }]);
    expect(await repo.performance.listAll()).toMatchObject([{
      requests: 1, tpotSamples: 1, tpotUsSum: 100_000,
      errorsWithOutput: failed ? 1 : 0, errorsNoOutput: 0,
    }]);
    dump!.finalize(200, 0);
    await Promise.all(pending);
    expect(runRecordOf(stubs.stored[0]?.record).meta).toMatchObject({
      inputTokens: 30, outputTokens: 5, model: 'm',
      error: failed ? { kind: 'failed', reason: 'Original source failure' } : null,
    });
  });
  it('retains earlier candidate calls when a later stage throws after reading current usage', async () => {
    const repo = new InMemoryRepo(); initRepo(repo);
    const work: Promise<unknown>[] = [];
    const original = new Error('post-reading stage failure');
    type Entry = Pick<GatewayFacts, 'route.attempt' | 'serve.usage.prior'>;
    type Reply = Entry & Pick<GatewayFacts, 'response.usage.billable' | 'response.http.status'>;
    const afterReading = defineStage<Entry, Entry, Reply, Reply>({
      name: 'afterReading',
      through: { request: { needs: ['route.attempt'], consumes: [], provides: [] }, response: { needs: ['response.usage.billable'], consumes: [], provides: [] } },
      execute: async (facts, next) => {
        const back = await next({ ...facts });
        if (facts['route.attempt'].upstreamId === 'second') throw original;
        return { ...back };
      },
    });
    const source = defineStage<Entry, Reply>({
      name: 'observe', return: { provides: ['response.usage.billable', 'response.http.status'] },
      execute: async facts => move({
        ...facts, 'response.http.status': facts['route.attempt'].upstreamId === 'first' ? 429 : 200,
        'response.usage.billable': [{
          identity: {
            model: 'm', upstream: facts['route.attempt'].upstreamId, modelKey: 'm', pricing: null,
          }, quantities: { input_tokens: '10', output_tokens: '2' },
        }],
      }),
    });
    const pipeline = compose('failedAfterReading', [
      writeSettlement(facts => Number(facts['response.http.status']) >= 400),
      failover({ failed: facts => Number(facts['response.http.status']) >= 400, owns: [] }), afterReading, source,
    ]);
    await expect(run(pipeline, move({
      'serve.candidates': ['first', 'second'].map((upstreamId, candidateId) => ({
        upstreamId, candidateId, modelId: 'm', flags: [],
      })),
    }), { gateway: mockGatewayCtx({}), background: (promise: Promise<unknown>) => { work.push(promise); } })).rejects.toBe(original);
    await Promise.all(work);
    expect((await repo.usage.listAll()).map(row => row.upstream).sort()).toEqual(['first', 'second']);
  });

});
