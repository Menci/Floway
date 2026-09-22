import { describe, expect, it } from 'vitest';

import { modelsAreValid } from '../../../src/components/upstream-editor/model-validation';

describe('manual model validation', () => {
  it('rejects the same incomplete identities and endpoint contracts as the gateway', () => {
    expect(modelsAreValid([{ upstreamModelId: '', kind: 'chat', endpoints: { openaiChatCompletions: {} } }])).toBe(false);
    expect(modelsAreValid([{ upstreamModelId: 'ranker', kind: 'rerank', endpoints: { rerank: {} } }])).toBe(false);
    expect(modelsAreValid([{
      upstreamModelId: 'ranker',
      kind: 'rerank',
      endpoints: { rerank: {} },
      rerankTarget: { protocol: 'cohere-v2' },
    }])).toBe(true);
  });
});
