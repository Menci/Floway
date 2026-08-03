import { describe, expect, it } from 'vitest';

import { indexCatalog } from '../../../src/components/models/catalog-index';
import { effectiveUpstreamCap, isModelReachable, reachableModels } from '../../../src/components/models/reachability';
import { aliasModel, catalogModel } from '../../api/model-fixture';

describe('model reachability', () => {
  it('intersects API-key and owner upstream caps', () => {
    expect(effectiveUpstreamCap(['u1', 'u2'], ['u2', 'u3'])).toEqual(['u2']);
    expect(effectiveUpstreamCap(null, ['u1'])).toEqual(['u1']);
    expect(effectiveUpstreamCap(null, null)).toBeNull();
  });

  it('resolves alias targets through the effective cap', () => {
    const real = catalogModel('real', { upstreams: ['u1'] });
    const alias = aliasModel('alias', [real.id]);
    const catalog = indexCatalog([real, alias]);
    expect(isModelReachable(alias, catalog, ['u1'])).toBe(true);
    expect(isModelReachable(alias, catalog, ['u2'])).toBe(false);
  });

  it('keeps only the catalog entries an alias or an upstream binding can reach', () => {
    const catalog = [
      catalogModel('allowed', { upstreams: ['u1'] }),
      catalogModel('key-denied', { upstreams: ['u2'] }),
      catalogModel('user-denied', { upstreams: ['u3'] }),
      aliasModel('alias-allowed', ['allowed', 'user-denied']),
      aliasModel('alias-denied', ['user-denied']),
      aliasModel('alias-missing', ['missing']),
    ];

    expect(reachableModels(catalog, effectiveUpstreamCap(['u1', 'u2', 'u3'], ['u1', 'u2']))
      .map(entry => entry.id))
      .toEqual(['allowed', 'key-denied', 'alias-allowed']);
    expect(reachableModels(catalog, [])).toEqual([]);
  });

  it('narrows by the caller predicate without regard to endpoint surface', () => {
    const responsesOnly = catalogModel('responses-only', { upstreams: ['a'], endpoints: { responses: {} } });
    const alias = aliasModel('alias', ['responses-only'], { endpoints: { responses: {} } });
    const chatOnly = catalogModel('chat-only', { upstreams: ['a'], endpoints: { chatCompletions: {} } });
    const embedding = catalogModel('embedding', { upstreams: ['a'], kind: 'embedding', endpoints: { embeddings: {} } });

    expect(reachableModels([responsesOnly, alias, chatOnly, embedding], ['a'], model => model.kind === 'chat')
      .map(entry => entry.id))
      .toEqual(['responses-only', 'alias', 'chat-only']);
  });
});
