import { describe, expect, it } from 'vitest';

import {
  PRICING_FIELDS_BY_KIND,
  pricingEntryDraftsFor,
  pricingFieldRate,
  pricingFromDrafts,
  pricingIsValid,
  withRate,
  withThresholdCoordinate,
} from '../../../src/components/upstream-editor/pricing-model';
import type { ModelPricing } from '@floway-dev/protocols/browser';

const baseOnly = (rates: Record<string, string>): ModelPricing => ({ entries: [{ rates }] });

describe('pricing editor model', () => {
  it('keeps sub-cent rates exact instead of rounding through a float', () => {
    const [draft] = pricingEntryDraftsFor(baseOnly({}));
    const field = PRICING_FIELDS_BY_KIND.chat.find(candidate => candidate.metric === 'input_tokens')!;

    const priced = withRate(draft!, field, '0.0028');
    expect(priced.rates.input_tokens).toBe('0.0000000028');
    expect(pricingFieldRate(priced, field)).toBe('0.0028');
  });

  it('keeps selectors and rates when editing an override', () => {
    const drafts = pricingEntryDraftsFor({
      entries: [
        { rates: { input_tokens: '1', output_tokens: '2' } },
        { selector: { serviceTier: 'priority' }, rates: { input_tokens: '3', output_tokens: '4' } },
      ],
    });
    const next = [drafts[0]!, withThresholdCoordinate(drafts[1]!, 'inputTokens', { operator: 'gte', value: 272_000 })];

    expect(pricingFromDrafts(next)).toEqual({
      entries: [
        { rates: { input_tokens: '1', output_tokens: '2' } },
        {
          selector: { serviceTier: 'priority', inputTokens: { operator: 'gte', value: 272_000 } },
          rates: { input_tokens: '3', output_tokens: '4' },
        },
      ],
    });
    expect(pricingIsValid(next, undefined)).toBe(true);
  });
});
