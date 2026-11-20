import { describe, expect, it } from 'vitest';

import { parseModels, serializeModels } from '../../../src/components/upstream-editor/models-yaml';

const RERANK_MODEL = { upstreamModelId: 'rerank-v2', kind: 'rerank', endpoints: { rerank: {} }, rerankTarget: { protocol: 'cohere-v2' } } as const;

describe('models YAML rejection', () => {
  it('rejects a rerank model on an upstream that cannot host one', () => {
    expect(parseModels(serializeModels([{ ...RERANK_MODEL }]), { allowRerank: false }).ok).toBe(false);
    expect(parseModels(serializeModels([{ ...RERANK_MODEL }]), { allowRerank: true }).ok).toBe(true);
  });
});
