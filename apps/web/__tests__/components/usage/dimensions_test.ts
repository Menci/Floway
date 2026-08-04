import { describe, expect, it } from 'vitest';

import { clearGroupedUsageFilter, filterUsageRecords, usageUpstreamValue } from '../../../src/components/usage/dimensions';
import type { DisplayUsageRecord } from '../../../src/components/usage/types';

const record = (keyId: string, model: string, upstream: string | null): DisplayUsageRecord => ({
  keyId,
  model,
  upstream,
  hour: '2026-08-05T00',
  requests: 1,
  metrics: {},
  cost: null,
});

describe('usage dimensions', () => {
  it('ORs values within a filter and ANDs dimensions', () => {
    const records = [
      record('key-1', 'gpt-5', 'up-1'),
      record('key-1', 'claude-opus-4-7', 'up-1'),
      record('key-2', 'gpt-5', 'up-2'),
    ];

    expect(filterUsageRecords(records, {
      identity: ['key-1'],
      model: ['gpt-5', 'claude-opus-4-7'],
      upstream: [usageUpstreamValue('up-1')],
    })).toEqual(records.slice(0, 2));
  });

  it('clears the active grouping dimension only', () => {
    expect(clearGroupedUsageFilter({ identity: ['key-1'], model: ['gpt-5'], upstream: ['upstream:up-1'] }, 'model'))
      .toEqual({ identity: ['key-1'], model: [], upstream: ['upstream:up-1'] });
  });
});
