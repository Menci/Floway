import { describe, expect, it } from 'vitest';

import { pruneLimitsForKind } from '../../../src/components/models/limits';

describe('model limit fields by kind', () => {
  it('drops the limits a kind cannot state', () => {
    const limits = { max_context_window_tokens: 1_000_000, max_prompt_tokens: 872_000, max_output_tokens: 128_000 };
    expect(pruneLimitsForKind(limits, 'chat')).toEqual(limits);
    expect(pruneLimitsForKind(limits, 'decision')).toEqual({ max_context_window_tokens: 1_000_000 });
    expect(pruneLimitsForKind(limits, 'image')).toBeUndefined();
  });
});
