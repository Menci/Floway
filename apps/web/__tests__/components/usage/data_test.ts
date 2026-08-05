import { describe, expect, it } from 'vitest';

import { buildUsageOverviewQuery, metricsFromWire } from '../../../src/components/usage/data';

describe('usage response normalization', () => {
  it('indexes gateway metric rows by billing metric for chart consumers', () => {
    expect(metricsFromWire([
      { metric: 'input_tokens', quantity: '9007199254740993' },
      { metric: 'output_tokens', quantity: '42' },
    ])).toEqual({
      input_tokens: '9007199254740993',
      output_tokens: '42',
    });
  });
});

describe('buildUsageOverviewQuery', () => {
  it('uses the Performance overview query vocabulary', () => {
    const query = buildUsageOverviewQuery('7d', 'userId', {
      model: ['gpt-5', 'claude'],
      upstream: ['none'],
      userId: [],
      keyId: ['key-1'],
    }, Date.UTC(2026, 7, 5, 12));

    expect(query).toMatchObject({
      bucket: '4h',
      group_by: 'userId',
      filter_model: ['gpt-5', 'claude'],
      filter_upstream: ['none'],
      filter_user_id: [],
      filter_key_id: ['key-1'],
    });
  });
});
