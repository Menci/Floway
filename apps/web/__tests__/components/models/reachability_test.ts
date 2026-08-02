import { describe, expect, it } from 'vitest';

import { indexCatalog } from '../../../src/components/models/catalog-index';
import { effectiveUpstreamCap, isModelReachable } from '../../../src/components/models/reachability';
import { aliasModel, chatModel } from '../../api/model-fixture';

describe('model reachability', () => {
  it('intersects API-key and owner upstream caps', () => {
    expect(effectiveUpstreamCap(['u1', 'u2'], ['u2', 'u3'])).toEqual(['u2']);
    expect(effectiveUpstreamCap(null, ['u1'])).toEqual(['u1']);
    expect(effectiveUpstreamCap(null, null)).toBeNull();
  });

  it('resolves alias targets through the effective cap', () => {
    const real = chatModel('real', { upstreams: ['u1'] });
    const alias = aliasModel('alias', [real.id]);
    const catalog = indexCatalog([real, alias]);
    expect(isModelReachable(alias, catalog, ['u1'])).toBe(true);
    expect(isModelReachable(alias, catalog, ['u2'])).toBe(false);
  });
});
