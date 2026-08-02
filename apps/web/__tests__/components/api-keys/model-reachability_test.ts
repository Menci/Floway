import { describe, expect, it } from 'vitest';

import { modelsForAgentSetup } from '../../../src/components/api-keys/model-reachability';
import { aliasModel, chatModel } from '../../api/model-fixture';

describe('Agent Setup model reachability', () => {
  it('keeps only real and alias models reachable by the effective cap', () => {
    const catalog = [
      chatModel('allowed', { upstreams: ['u1'] }),
      chatModel('key-denied', { upstreams: ['u2'] }),
      chatModel('user-denied', { upstreams: ['u3'] }),
      aliasModel('alias-allowed', ['allowed', 'user-denied']),
      aliasModel('alias-denied', ['user-denied']),
      aliasModel('alias-missing', ['missing']),
    ];

    expect(modelsForAgentSetup(catalog, ['u1', 'u2', 'u3'], ['u1', 'u2'])
      .map(entry => entry.id))
      .toEqual(['allowed', 'key-denied', 'alias-allowed']);
  });
});
