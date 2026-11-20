import { describe, expect, it } from 'vitest';

import { parseDialTimeoutInput } from '../../../src/components/proxy/config';

describe('proxy dial timeout', () => {
  it('distinguishes the default, malformed values, and the upper bound', () => {
    expect(parseDialTimeoutInput('')).toEqual({ value: null, error: null });
    expect(parseDialTimeoutInput('1.5')).toEqual({ value: null, error: 'positive' });
    expect(parseDialTimeoutInput('601')).toEqual({ value: null, error: 'maximum' });
    expect(parseDialTimeoutInput('600')).toEqual({ value: 600, error: null });
  });
});
