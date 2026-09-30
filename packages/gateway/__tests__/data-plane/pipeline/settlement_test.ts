import { describe, expect, it, vi } from 'vitest';

import { settleBillable } from '../../../src/data-plane/pipeline/settlement.ts';
import { initDumpBroker, initDumpStore } from '../../../src/dump/registry.ts';
import { openRunDump } from '../../../src/dump/run-sink.ts';
import { initRepo } from '../../../src/repo/index.ts';
import { installDumpStubs, runRecordOf } from '../../dump/test-fixtures.ts';
import { InMemoryRepo } from '../../repo/memory.ts';
import { mockGatewayCtx } from '../../test-utils/gateway-ctx.ts';
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
    settleBillable({ gateway, background, log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} } }, [
      { identity, quantities: { input_tokens: '10', output_tokens: '2' } },
      { identity, quantities: { input_tokens: '20', output_tokens: '3' } },
    ], failed, 500);
    await Promise.all(pending);
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
});
