import { describe, expect, test } from 'vitest';

import { pricingForKimiCodePublicModelId } from '../src/pricing.ts';
import { perMillionTokenRates, priceRequest } from '@floway-dev/protocols/common';

describe('pricingForKimiCodePublicModelId', () => {
  // https://platform.kimi.ai/docs/pricing/chat
  test('prices K3.1 Pro priority at double I/O and writes while keeping cache reads unchanged', () => {
    expect(priceRequest(pricingForKimiCodePublicModelId('kimi-k3.1-pro'), { serviceTier: 'priority' }).rates).toEqual(perMillionTokenRates({
      input_tokens: '4', input_cache_read_tokens: '0.2', input_cache_write_tokens: '4', input_cache_write_1h_tokens: '8', output_tokens: '20',
    }));
  });

  test.each(['kimi-k3-256k'])('leaves withheld variants and non-public identities unpriced: %s', id => {
    expect(pricingForKimiCodePublicModelId(id)).toBeNull();
    expect(priceRequest(pricingForKimiCodePublicModelId(id), { serviceTier: 'priority' }).rates).toBeNull();
  });
});
