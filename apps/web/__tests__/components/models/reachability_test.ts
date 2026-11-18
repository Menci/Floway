import { describe, expect, it } from 'vitest';

import { reachableModels } from '../../../src/components/models/reachability';
import { aliasModel, catalogModel } from '../../api/model-fixture';

describe('model reachability', () => {
  it('keeps only the catalog entries an alias or an upstream binding can reach', () => {
    const catalog = [
      catalogModel('allowed', { upstreams: ['u1'] }),
      catalogModel('also-allowed', { upstreams: ['u2'] }),
      catalogModel('denied', { upstreams: ['u3'] }),
      aliasModel('alias-allowed', ['allowed', 'denied']),
      aliasModel('alias-denied', ['denied']),
      aliasModel('alias-missing', ['missing']),
    ];

    expect(reachableModels(catalog, ['u1', 'u2'])
      .map(entry => entry.id))
      .toEqual(['allowed', 'also-allowed', 'alias-allowed']);
    expect(reachableModels(catalog, [])).toEqual([]);
  });

  it('narrows by the caller predicate without regard to endpoint surface', () => {
    const openaiResponsesOnly = catalogModel('responses-only', { upstreams: ['a'], endpoints: { openaiResponses: {} } });
    const alias = aliasModel('alias', ['responses-only'], { endpoints: { openaiResponses: {} } });
    const chatOnly = catalogModel('chat-only', { upstreams: ['a'], endpoints: { openaiChatCompletions: {} } });
    const embedding = catalogModel('embedding', { upstreams: ['a'], kind: 'embedding', endpoints: { openaiEmbeddings: {} } });

    expect(reachableModels([openaiResponsesOnly, alias, chatOnly, embedding], ['a'], model => model.kind === 'chat')
      .map(entry => entry.id))
      .toEqual(['responses-only', 'alias', 'chat-only']);
  });
});
