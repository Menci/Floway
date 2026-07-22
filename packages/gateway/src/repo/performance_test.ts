import { describe, expect, it } from 'vitest';

import { InMemoryRepo } from './memory.ts';
import { SqlRepo } from './sql.ts';
import { createSqliteTestDb } from './test-sqlite.ts';
import type {
  PerformanceDimensions,
  PerformanceRepo,
  PerformanceSample,
  PerformanceTelemetryRecord,
} from './types.ts';

const sample = (over: Partial<PerformanceSample> = {}): PerformanceSample => ({
  hour: '2026-06-30T09',
  keyId: 'key_a',
  model: 'claude-opus-4-8',
  upstream: 'anthropic-1',
  operation: 'chat',
  runtimeLocation: 'hkg',
  ttftMs: 340,
  tpotUs: 15_000,
  success: true,
  ...over,
});

const errSample = (over: Partial<PerformanceDimensions> = {}): PerformanceDimensions => ({
  hour: '2026-06-30T09',
  keyId: 'key_a',
  model: 'claude-opus-4-8',
  upstream: 'anthropic-1',
  operation: 'chat',
  runtimeLocation: 'hkg',
  ...over,
});

const impls: Array<{ name: string; open: () => Promise<PerformanceRepo> }> = [
  { name: 'memory', open: async () => new InMemoryRepo().performance },
  { name: 'sqlite', open: async () => new SqlRepo(await createSqliteTestDb()).performance },
];

for (const impl of impls) {
  describe(`PerformanceRepo (${impl.name})`, () => {
    it('records a sample into summary + one TTFT bucket + one TPOT bucket', async () => {
      const repo = await impl.open();
      await repo.recordSample(sample());
      const rows = await repo.listAll();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        hour: '2026-06-30T09',
        keyId: 'key_a',
        model: 'claude-opus-4-8',
        upstream: 'anthropic-1',
        runtimeLocation: 'hkg',
        requests: 1,
        ttftSamplesOk: 1,
        errorsWithOutput: 0,
        errorsNoOutput: 0,
        neutral: 0,
        tpotSamples: 1,
        ttftMsSum: 340,
        tpotUsSum: 15_000,
      });
      const ttft = rows[0]!.buckets.find(b => b.metric === 'ttft_ms')!;
      const tpot = rows[0]!.buckets.find(b => b.metric === 'tpot_us')!;
      expect(ttft).toEqual({ metric: 'ttft_ms', lower: 300, upper: 500, count: 1 });
      expect(tpot).toEqual({ metric: 'tpot_us', lower: 14_286, upper: 16_667, count: 1 });
    });

    it('records a zero-output error into summary requests + errorsNoOutput only, no bucket rows', async () => {
      const repo = await impl.open();
      await repo.recordZeroOutputError(errSample());
      const rows = await repo.listAll();
      expect(rows[0]).toMatchObject({ requests: 1, ttftSamplesOk: 0, errorsWithOutput: 0, errorsNoOutput: 1, neutral: 0, tpotSamples: 0, ttftMsSum: 0, tpotUsSum: 0 });
      expect(rows[0]!.buckets).toEqual([]);
    });

    it('routes a failed sample into errorsWithOutput (not ttftSamplesOk)', async () => {
      const repo = await impl.open();
      await repo.recordSample(sample({ success: false }));
      const [row] = await repo.listAll();
      expect(row).toMatchObject({
        requests: 1,
        ttftSamplesOk: 0,
        errorsWithOutput: 1,
        errorsNoOutput: 0,
        neutral: 0,
        tpotSamples: 1,
        ttftMsSum: 340,
        tpotUsSum: 15_000,
      });
      expect(row!.buckets.some(b => b.metric === 'ttft_ms')).toBe(true);
      expect(row!.buckets.some(b => b.metric === 'tpot_us')).toBe(true);
    });

    it('additive upsert accumulates sums, samples, and bucket counts', async () => {
      const repo = await impl.open();
      // Both samples fall in the same TTFT bucket [200, 300] and same TPOT bucket [10000, 12500]
      // so a single (lower, upper) entry accumulates count=2 for each metric.
      await repo.recordSample(sample({ ttftMs: 250, tpotUs: 10_500 }));
      await repo.recordSample(sample({ ttftMs: 260, tpotUs: 11_500 }));
      const [row] = await repo.listAll();
      expect(row).toMatchObject({ requests: 2, ttftSamplesOk: 2, tpotSamples: 2, ttftMsSum: 510, tpotUsSum: 22_000 });
      const ttft = row!.buckets.find(b => b.metric === 'ttft_ms' && b.lower === 200 && b.upper === 300)!;
      expect(ttft.count).toBe(2);
      const tpot = row!.buckets.find(b => b.metric === 'tpot_us' && b.lower === 10_000 && b.upper === 12_500)!;
      expect(tpot.count).toBe(2);
    });

    it('separates rows by any dimension change (upstream)', async () => {
      const repo = await impl.open();
      await repo.recordSample(sample({ upstream: 'anthropic-1' }));
      await repo.recordSample(sample({ upstream: 'anthropic-2' }));
      const rows = await repo.listAll();
      expect(rows).toHaveLength(2);
      expect(new Set(rows.map(r => r.upstream))).toEqual(new Set(['anthropic-1', 'anthropic-2']));
    });

    it('query filters by keyId and time range', async () => {
      const repo = await impl.open();
      await repo.recordSample(sample({ hour: '2026-06-30T08', keyId: 'key_a' }));
      await repo.recordSample(sample({ hour: '2026-06-30T09', keyId: 'key_b' }));
      const scoped = await repo.query({ keyId: 'key_a', start: '2026-06-30T00', end: '2026-06-30T23' });
      expect(scoped).toHaveLength(1);
      expect(scoped[0]!.keyId).toBe('key_a');
    });

    it('set() replaces (not adds) a row and its buckets', async () => {
      const repo = await impl.open();
      await repo.recordSample(sample({ ttftMs: 100, tpotUs: 8_000 }));
      const [orig] = await repo.listAll();
      await repo.set({
        ...orig!,
        requests: 5,
        ttftSamplesOk: 5,
        errorsWithOutput: 0,
        errorsNoOutput: 0,
        neutral: 0,
        tpotSamples: 5,
        ttftMsSum: 500,
        tpotUsSum: 40_000,
        buckets: [
          { metric: 'ttft_ms', lower: 0, upper: 50, count: 5 },
          { metric: 'tpot_us', lower: 5_000, upper: 10_000, count: 5 },
        ],
      });
      const [after] = await repo.listAll();
      expect(after).toMatchObject({ requests: 5, ttftSamplesOk: 5, tpotSamples: 5, ttftMsSum: 500, tpotUsSum: 40_000 });
      expect(after!.buckets).toHaveLength(2);
    });

    it('records TTFT overflow bucket for very slow requests beyond the top edge', async () => {
      const repo = await impl.open();
      await repo.recordSample(sample({ ttftMs: 600_000 }));
      const [row] = await repo.listAll();
      const overflow = row!.buckets.find(b => b.metric === 'ttft_ms' && b.upper === null)!;
      expect(overflow).toEqual({ metric: 'ttft_ms', lower: 300_000, upper: null, count: 1 });
    });

    it('TTFT-only sample (no tpotUs) records TTFT bucket without touching TPOT columns', async () => {
      const repo = await impl.open();
      const { tpotUs: _tpot, ...ttftOnly } = sample();
      await repo.recordSample(ttftOnly);
      const [row] = await repo.listAll();
      expect(row).toMatchObject({ requests: 1, ttftSamplesOk: 1, tpotSamples: 0, ttftMsSum: 340, tpotUsSum: 0 });
      expect(row!.buckets.some(b => b.metric === 'ttft_ms')).toBe(true);
      expect(row!.buckets.some(b => b.metric === 'tpot_us')).toBe(false);
    });

    it('recordNeutral bumps requests and neutral', async () => {
      const repo = await impl.open();
      await repo.recordNeutral(errSample({ operation: 'embeddings' }));
      const rows = await repo.listAll();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ requests: 1, neutral: 1, ttftSamplesOk: 0, errorsWithOutput: 0, errorsNoOutput: 0, tpotSamples: 0, ttftMsSum: 0, tpotUsSum: 0 });
      expect(rows[0]!.buckets).toEqual([]);
    });

    it('recordNeutral is additive across calls', async () => {
      const repo = await impl.open();
      await repo.recordNeutral(errSample({ operation: 'embeddings' }));
      await repo.recordNeutral(errSample({ operation: 'embeddings' }));
      await repo.recordNeutral(errSample({ operation: 'embeddings' }));
      const [row] = await repo.listAll();
      expect(row!.requests).toBe(3);
      expect(row!.neutral).toBe(3);
      expect(row!.errorsNoOutput).toBe(0);
      expect(row!.ttftSamplesOk).toBe(0);
      expect(row!.tpotSamples).toBe(0);
    });

    it('different operations create different rows', async () => {
      const repo = await impl.open();
      await repo.recordSample(sample({ operation: 'chat' }));
      await repo.recordNeutral(errSample({ operation: 'embeddings' }));
      const rows = await repo.listAll();
      expect(rows).toHaveLength(2);
      expect(new Set(rows.map(r => r.operation))).toEqual(new Set(['chat', 'embeddings']));
    });
  });
}

describe('SqlPerformanceRepo upsertSummary set-mode guard', () => {
  it('throws when set() is handed a record missing a count column', async () => {
    const repo = new SqlRepo(await createSqliteTestDb()).performance;
    // TS enforces every count on the public shape; test the runtime guard by
    // casting a partial through, mirroring an `as`-cast slipping past compile.
    const incomplete = {
      ...errSample(),
      requests: 5,
      ttftSamplesOk: 5,
      errorsWithOutput: 0,
      errorsNoOutput: 0,
      neutral: 0,
      tpotSamples: 5,
      // ttftMsSum omitted on purpose
      tpotUsSum: 40_000,
      buckets: [],
    } as unknown as PerformanceTelemetryRecord;
    await expect(repo.set(incomplete)).rejects.toThrow(/missing count column ttft_ms_sum/);
  });
});

describe('SqlPerformanceRepo operation vocabulary', () => {
  it('persists rerank rows through the open operation schema', async () => {
    const repo = new SqlRepo(await createSqliteTestDb()).performance;
    await repo.recordNeutral(errSample({ operation: 'rerank' }));
    const [row] = await repo.listAll();
    expect(row).toMatchObject({ operation: 'rerank', requests: 1, neutral: 1 });
  });

  it('rejects an unknown stored operation at hydration', async () => {
    const db = await createSqliteTestDb();
    await db.prepare(
      `INSERT INTO performance_summary (hour, key_id, model, upstream, operation, runtime_location)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).bind('2026-06-30T09', 'key_a', 'model', 'upstream', 'future-operation', 'hkg').run();

    const repo = new SqlRepo(db).performance;
    await expect(repo.listAll()).rejects.toThrow('Invalid performance operation: "future-operation"');
  });
});
