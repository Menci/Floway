import { describe, expect, test } from 'vitest';

import { telemetryModelIdentity } from '../../../../src/data-plane/shared/telemetry/attribution.ts';
import { stubModelCandidate } from '@floway-dev/test-utils';

describe('telemetryModelIdentity', () => {
  test('captures pricing from the exact dispatched provider model', () => {
    const pricing = { entries: [{ rates: { input_tokens: '3', output_tokens: '12' } }] };
    const candidate = stubModelCandidate({ model: { pricing } });
    expect(telemetryModelIdentity(candidate, 'raw-model')).toEqual({
      model: 'test-model',
      upstream: 'test-upstream',
      modelKey: 'raw-model',
      pricing,
    });
  });
});
