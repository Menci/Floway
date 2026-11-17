import { describe, expect, it } from 'vitest';

import { parseModels, serializeModels } from '../../../src/components/upstream-editor/models-yaml';

const CHAT_MODEL = { upstreamModelId: 'gpt-5', kind: 'chat', endpoints: { openaiChatCompletions: {} } } as const;
const RERANK_MODEL = { upstreamModelId: 'rerank-v2', kind: 'rerank', endpoints: { rerank: {} }, rerankTarget: { protocol: 'cohere-v2' } } as const;

describe('models YAML round trip', () => {
  it('parses back what it serialized', () => {
    const parsed = parseModels(serializeModels([{ ...CHAT_MODEL }]), { allowRerank: false });
    expect(parsed).toEqual({ ok: true, models: [CHAT_MODEL] });
  });
});

describe('models YAML rejection', () => {
  it('rejects a payload that is not an array', () => {
    const parsed = parseModels('upstreamModelId: gpt-5\n', { allowRerank: false });
    expect(parsed).toMatchObject({ ok: false });
    expect(parsed.ok === false && parsed.message).toContain('must be an array');
  });

  it('rejects a rerank model on an upstream that cannot host one', () => {
    expect(parseModels(serializeModels([{ ...RERANK_MODEL }]), { allowRerank: false }))
      .toEqual({ ok: false, message: 'Rerank models require a custom upstream' });
    expect(parseModels(serializeModels([{ ...RERANK_MODEL }]), { allowRerank: true }).ok).toBe(true);
  });
});
