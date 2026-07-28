import { describe, expect, it } from 'vitest';

import type { ControlPlaneModel } from '../../../src/api/types';
import { effectiveUpstreamCap, isModelReachable } from '../../../src/components/models/reachability';

const model = (id: string, upstreamId: string): ControlPlaneModel => ({
  id,
  object: 'model',
  type: 'model',
  display_name: id,
  kind: 'chat',
  limits: {},
  endpoints: { responses: {} },
  upstreams: [{ id: upstreamId, name: upstreamId, kind: 'custom', color: null }],
});

describe('model reachability', () => {
  it('intersects API-key and owner upstream caps', () => {
    expect(effectiveUpstreamCap(['u1', 'u2'], ['u2', 'u3'])).toEqual(['u2']);
    expect(effectiveUpstreamCap(null, ['u1'])).toEqual(['u1']);
    expect(effectiveUpstreamCap(null, null)).toBeNull();
  });

  it('resolves alias targets through the effective cap', () => {
    const real = model('real', 'u1');
    const alias: ControlPlaneModel = {
      ...model('alias', 'ignored'),
      upstreams: [],
      aliasedFrom: {
        selection: 'first-available',
        targets: [{ target_model_id: real.id, rules: {} }],
      },
    };
    expect(isModelReachable(alias, [real, alias], ['u1'])).toBe(true);
    expect(isModelReachable(alias, [real, alias], ['u2'])).toBe(false);
  });
});
