import { describe, expect, it } from 'vitest';

import {
  PRICING_FIELDS_BY_KIND,
  pricingEntryDraftsFor,
  pricingFieldRate,
  pricingFromDrafts,
  pricingIsValid,
  visiblePricingFields,
  withEqualityCoordinate,
  withRate,
  withThresholdCoordinate,
} from '../../../src/components/upstream-editor/pricing-model';
import type { ModelPricing } from '@floway-dev/protocols/common';

const baseOnly = (rates: Record<string, string>): ModelPricing => ({ entries: [{ rates }] });

describe('pricing editor model', () => {
  it('distinguishes absent pricing from an invalid empty catalog', () => {
    expect(pricingIsValid([], undefined)).toBe(true);
    expect(pricingIsValid([], { entries: [] })).toBe(false);
  });

  it('authors rates per display unit and stores them per base unit', () => {
    const [draft] = pricingEntryDraftsFor(baseOnly({}));
    const field = PRICING_FIELDS_BY_KIND.chat.find(candidate => candidate.metric === 'input_tokens')!;

    const priced = withRate(draft!, field, '3');
    expect(priced.rates.input_tokens).toBe('0.000003');
    expect(pricingFieldRate(priced, field)).toBe('3');
  });

  it('keeps sub-cent rates exact instead of rounding through a float', () => {
    const [draft] = pricingEntryDraftsFor(baseOnly({}));
    const field = PRICING_FIELDS_BY_KIND.chat.find(candidate => candidate.metric === 'input_tokens')!;

    const priced = withRate(draft!, field, '0.0028');
    expect(priced.rates.input_tokens).toBe('0.0000000028');
    expect(pricingFieldRate(priced, field)).toBe('0.0028');
  });

  it('prices rerank per thousand searches and transcription per second', () => {
    const [draft] = pricingEntryDraftsFor(baseOnly({}));
    const searches = PRICING_FIELDS_BY_KIND.rerank.find(candidate => candidate.metric === 'rerank_searches')!;
    const seconds = PRICING_FIELDS_BY_KIND.transcription.find(candidate => candidate.metric === 'input_audio_seconds')!;

    expect(withRate(draft!, searches, '2').rates.rerank_searches).toBe('0.002');
    expect(withRate(draft!, seconds, '2').rates.input_audio_seconds).toBe('2');
  });

  it('clears a rate when its input is emptied', () => {
    const [draft] = pricingEntryDraftsFor(baseOnly({ input_tokens: '0.000003' }));
    const field = PRICING_FIELDS_BY_KIND.chat.find(candidate => candidate.metric === 'input_tokens')!;

    expect(withRate(draft!, field, '').rates.input_tokens).toBeUndefined();
  });

  it('shows a priced metric the kind does not declare', () => {
    const drafts = pricingEntryDraftsFor(baseOnly({ input_tokens: '0.000003', rerank_searches: '0.002' }));
    const metrics = visiblePricingFields(drafts, 'chat').map(field => field.metric);

    expect(metrics).toContain('rerank_searches');
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

  it('drops an emptied equality coordinate rather than storing a blank one', () => {
    const drafts = pricingEntryDraftsFor({ entries: [{ selector: { serviceTier: 'priority' }, rates: { input_tokens: '1' } }] });
    const cleared = withEqualityCoordinate(drafts[0]!, 'serviceTier', '   ');

    expect(pricingFromDrafts([cleared])).toEqual({ entries: [{ rates: { input_tokens: '1' } }] });
  });

  it('does not mutate the pricing it was seeded from', () => {
    const pricing = baseOnly({ input_tokens: '1' });
    const drafts = pricingEntryDraftsFor(pricing);
    drafts[0]!.rates.input_tokens = '9';

    expect(pricing.entries[0]!.rates.input_tokens).toBe('1');
  });
});
