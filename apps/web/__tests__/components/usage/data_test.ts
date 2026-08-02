import { describe, expect, it } from 'vitest';

import { metricsFromWire } from '../../../src/components/usage/data';

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
