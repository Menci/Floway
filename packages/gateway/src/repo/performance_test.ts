import { describe, expect, it } from 'vitest';

import { InMemoryRepo } from './memory.ts';
import { createSqliteTestDb } from './test-sqlite.ts';
import type {
  PerformanceDimensions,
  PerformanceRepo,
  PerformanceSample,
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
  outputTokens: 128,
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
  { name: 'sqlite', open: async () => new (await import('./sql.ts')).SqlRepo(await createSqliteTestDb()).performance },
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
        errors: 0,
        ttftSamples: 1,
        tpotSamples: 1,
        ttftMsSum: 340,
        tpotUsSum: 15_000,
      });
      const ttft = rows[0]!.buckets.find(b => b.metric === 'ttft_ms')!;
      const tpot = rows[0]!.buckets.find(b => b.metric === 'tpot_us')!;
      expect(ttft).toEqual({ metric: 'ttft_ms', lower: 300, upper: 500, count: 1 });
      expect(tpot).toEqual({ metric: 'tpot_us', lower: 14_286, upper: 16_667, count: 1 });
    });

    it('records an error into summary requests + errors only, no bucket rows', async () => {
      const repo = await impl.open();
      await repo.recordError(errSample());
      const rows = await repo.listAll();
      expect(rows[0]).toMatchObject({ requests: 1, errors: 1, ttftSamples: 0, tpotSamples: 0, ttftMsSum: 0, tpotUsSum: 0 });
      expect(rows[0]!.buckets).toEqual([]);
    });

    it('additive upsert accumulates sums, samples, and bucket counts', async () => {
      const repo = await impl.open();
      // Both samples fall in the same TTFT bucket [200, 300] and same TPOT bucket [10000, 12500]
      // so a single (lower, upper) entry accumulates count=2 for each metric.
      await repo.recordSample(sample({ ttftMs: 250, tpotUs: 10_500, outputTokens: 50 }));
      await repo.recordSample(sample({ ttftMs: 260, tpotUs: 11_500, outputTokens: 90 }));
      const [row] = await repo.listAll();
      expect(row).toMatchObject({ requests: 2, ttftSamples: 2, tpotSamples: 2, ttftMsSum: 510, tpotUsSum: 22_000 });
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
        ttftSamples: 5,
        tpotSamples: 5,
        requests: 5,
        errors: 0,
        ttftMsSum: 500,
        tpotUsSum: 40_000,
        buckets: [
          { metric: 'ttft_ms', lower: 0, upper: 50, count: 5 },
          { metric: 'tpot_us', lower: 5_000, upper: 10_000, count: 5 },
        ],
      });
      const [after] = await repo.listAll();
      expect(after).toMatchObject({ ttftSamples: 5, tpotSamples: 5, ttftMsSum: 500, tpotUsSum: 40_000 });
      expect(after!.buckets).toHaveLength(2);
    });

    it('records TTFT overflow bucket for very slow requests beyond the top edge', async () => {
      const repo = await impl.open();
      await repo.recordSample(sample({ ttftMs: 600_000 }));
      const [row] = await repo.listAll();
      const overflow = row!.buckets.find(b => b.metric === 'ttft_ms' && b.upper === null)!;
      expect(overflow).toEqual({ metric: 'ttft_ms', lower: 300_000, upper: null, count: 1 });
    });

    it('single-token sample records TTFT only — no TPOT bucket, no tpotSamples increment', async () => {
      const repo = await impl.open();
      await repo.recordSample({ ...sample(), tpotUs: undefined, outputTokens: 1 });
      const [row] = await repo.listAll();
      expect(row).toMatchObject({ requests: 1, ttftSamples: 1, tpotSamples: 0, ttftMsSum: 340, tpotUsSum: 0 });
      expect(row!.buckets.some(b => b.metric === 'ttft_ms')).toBe(true);
      expect(row!.buckets.some(b => b.metric === 'tpot_us')).toBe(false);
    });

    it('sample without tpotUs (any outputTokens) records TTFT only', async () => {
      const repo = await impl.open();
      await repo.recordSample({ ...sample(), tpotUs: undefined, outputTokens: undefined });
      const [row] = await repo.listAll();
      expect(row).toMatchObject({ requests: 1, ttftSamples: 1, tpotSamples: 0 });
      expect(row!.buckets.some(b => b.metric === 'tpot_us')).toBe(false);
    });

    it('recordNeutral bumps requests only', async () => {
      const repo = await impl.open();
      await repo.recordNeutral(errSample({ operation: 'embeddings' }));
      const rows = await repo.listAll();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ requests: 1, errors: 0, ttftSamples: 0, tpotSamples: 0, ttftMsSum: 0, tpotUsSum: 0 });
      expect(rows[0]!.buckets).toEqual([]);
    });

    it('recordNeutral is additive across calls', async () => {
      const repo = await impl.open();
      await repo.recordNeutral(errSample({ operation: 'embeddings' }));
      await repo.recordNeutral(errSample({ operation: 'embeddings' }));
      await repo.recordNeutral(errSample({ operation: 'embeddings' }));
      const [row] = await repo.listAll();
      expect(row!.requests).toBe(3);
      expect(row!.errors).toBe(0);
      expect(row!.ttftSamples).toBe(0);
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
