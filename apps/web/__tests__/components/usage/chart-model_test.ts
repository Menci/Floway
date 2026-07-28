import { describe, expect, it } from 'vitest';

import { buildTokenChart } from '../../../src/components/usage/chart-model';
import type { DisplayUsageRecord, UsageBucket } from '../../../src/components/usage/types';

const bucket: UsageBucket = {
  key: '2026-07-28T12',
  label: '12:00 - 13:00',
  date: new Date('2026-07-28T04:00:00.000Z'),
};

const record = (metrics: DisplayUsageRecord['metrics']): DisplayUsageRecord => ({
  keyId: 'key-1',
  keyName: 'Key 1',
  model: 'model-1',
  hour: '2026-07-28T04',
  requests: 1,
  metrics,
  cost: null,
});

const chart = (metrics: DisplayUsageRecord['metrics']) => buildTokenChart({
  records: [record(metrics)],
  metadata: [{ id: 'key-1', name: 'Key 1' }],
  models: [],
  groupKey: 'keyId',
  hiddenOwn: new Set(),
  hiddenOther: new Set(),
  redactKeys: false,
  metric: 'cachedRate',
  range: 'today',
  buckets: [bucket],
});

describe('percentage chart series', () => {
  it('keeps a real zero-percent point', () => {
    expect(chart({ input_tokens: '10', input_cache_read_tokens: '0' }).data.lineChartData![0]!.data)
      .toEqual([expect.objectContaining({ y: 0 })]);
  });

  it('omits a percentage whose denominator does not exist', () => {
    expect(chart({}).data.lineChartData).toEqual([]);
  });
});

describe('cost chart series', () => {
  it('does not turn unavailable pricing into measured zero cost', () => {
    const model = buildTokenChart({
      records: [record({ input_tokens: '10' })],
      metadata: [{ id: 'key-1', name: 'Key 1' }],
      models: [],
      groupKey: 'keyId',
      hiddenOwn: new Set(),
      hiddenOther: new Set(),
      redactKeys: false,
      metric: 'cost',
      range: 'today',
      buckets: [bucket],
    });

    expect(model.data.lineChartData![0]!.data).toEqual([]);
  });
});
