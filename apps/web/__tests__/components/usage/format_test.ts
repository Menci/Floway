import { expect, it } from 'vitest';

import { formatMetricValue, formatSummaryMetric } from '../../../src/components/usage/format';
import { summarizeCounters } from '../../../src/components/usage/plot';

it('spells token figures with English magnitudes under a zh-Hans locale and keeps the exact total for the tile', () => {
  const summary = summarizeCounters({
    requests: 1, cost: null, input: '10437436481', output: '0', cacheRead: '0', cacheCreation: '0', inputImage: '0', outputImage: '0',
  });
  expect(formatSummaryMetric(summary, 'total', 'zh-Hans')).toEqual({ text: '10.4B', exact: '10,437,436,481' });
  expect(formatMetricValue(1_810_000_000, 'total', 'zh-Hans')).toBe('1.8B');
});
