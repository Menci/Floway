import { describe, expect, it } from 'vitest';

import type { ControlPlaneModel } from '../../../src/api/types';
import { effectiveUpstreamCap, modelsForAgentSetup } from '../../../src/components/api-keys/model-reachability';

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

const alias = (id: string, targets: string[]): ControlPlaneModel => ({
  id,
  object: 'model',
  type: 'model',
  display_name: id,
  kind: 'chat',
  limits: {},
  endpoints: { responses: {} },
  upstreams: [],
  aliasedFrom: {
    selection: 'first-available',
    targets: targets.map(target_model_id => ({ target_model_id, rules: {} })),
  },
});

describe('Agent Setup model reachability', () => {
  it('intersects API key and owner upstream caps', () => {
    expect(effectiveUpstreamCap(['u1', 'u2'], ['u2', 'u3'])).toEqual(['u2']);
    expect(effectiveUpstreamCap(null, ['u1'])).toEqual(['u1']);
    expect(effectiveUpstreamCap(null, null)).toBeNull();
  });

  it('keeps only real and alias models reachable by the effective cap', () => {
    const catalog = [
      model('allowed', 'u1'),
      model('key-denied', 'u2'),
      model('user-denied', 'u3'),
      alias('alias-allowed', ['allowed', 'user-denied']),
      alias('alias-denied', ['user-denied']),
      alias('alias-missing', ['missing']),
    ];

    expect(modelsForAgentSetup(catalog, ['u1', 'u2', 'u3'], ['u1', 'u2'])
      .map(entry => entry.id))
      .toEqual(['allowed', 'key-denied', 'alias-allowed']);
  });
});
