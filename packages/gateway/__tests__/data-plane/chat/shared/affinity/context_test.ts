import { describe, expect, test } from 'vitest';

import { AffinityRequestContext, affinityEgressOptions } from '../../../../../src/data-plane/chat/shared/affinity/index.ts';
import { mockGatewayCtx } from '../../../../test-utils/gateway-ctx.ts';
import { stubModelCandidate } from '@floway-dev/test-utils';

const SECRET = '00'.repeat(32);

describe('AffinityRequestContext', () => {
  test('rejects target access before candidate selection', () => {
    expect(() => new AffinityRequestContext(SECRET).selectedTarget()).toThrow(Error);
  });

  test('maps the selected candidate and its rule overlay into egress options', () => {
    const base = stubModelCandidate();
    const candidate = {
      ...stubModelCandidate({
        provider: { ...base.provider, upstreamId: 'upstream-selected' },
        model: { id: 'model-selected' },
      }),
      rules: { reasoning: { effort: 'high' } },
    };
    const affinity = new AffinityRequestContext(SECRET);
    affinity.select(candidate);

    const expectedTarget = {
      upstreamId: 'upstream-selected',
      modelId: 'model-selected',
      rules: { reasoning: { effort: 'high' } },
    };
    expect(affinity.selectedTarget()).toEqual(expectedTarget);
    expect(affinityEgressOptions({ ...mockGatewayCtx(), affinity })).toEqual({
      codec: affinity.codec,
      affinity: expectedTarget,
    });
  });
});

test('affinity egress rejects a non-chat request context', () => {
  expect(() => affinityEgressOptions(mockGatewayCtx())).toThrow(Error);
});
