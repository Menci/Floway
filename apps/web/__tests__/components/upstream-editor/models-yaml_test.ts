import { describe, expect, it } from 'vitest';

import { parseModels, serializeModels } from '../../../src/components/upstream-editor/models-yaml';

const CHAT_MODEL = { upstreamModelId: 'gpt-5', kind: 'chat', endpoints: { chatCompletions: {} } } as const;
const RERANK_MODEL = { upstreamModelId: 'rerank-v2', kind: 'rerank', endpoints: { rerank: {} }, rerankTarget: { protocol: 'cohere-v2' } } as const;

describe('models YAML round trip', () => {
  it('parses back what it serialized', () => {
    const parsed = parseModels(serializeModels([{ ...CHAT_MODEL }]), { allowRerank: false });
    expect(parsed).toEqual({ ok: true, models: [CHAT_MODEL] });
  });

  it('accepts a hand-written YAML list', () => {
    const parsed = parseModels('- upstreamModelId: gpt-5\n  kind: chat\n  endpoints:\n    chatCompletions: {}\n', { allowRerank: false });
    expect(parsed.ok).toBe(true);
  });
});

describe('models YAML rejection', () => {
  it('reports a syntax error rather than throwing', () => {
    const parsed = parseModels('- upstreamModelId: [', { allowRerank: false });
    expect(parsed.ok).toBe(false);
  });

  it('rejects a payload that is not an array', () => {
    const parsed = parseModels('upstreamModelId: gpt-5\n', { allowRerank: false });
    expect(parsed).toMatchObject({ ok: false });
    expect(parsed.ok === false && parsed.message).toContain('must be an array');
  });

  it('applies the same validation the gateway does', () => {
    const parsed = parseModels('- upstreamModelId: gpt-5\n  kind: telepathy\n  endpoints: {}\n', { allowRerank: false });
    expect(parsed.ok).toBe(false);
  });

  it('rejects a rerank model on an upstream that cannot host one', () => {
    expect(parseModels(serializeModels([{ ...RERANK_MODEL }]), { allowRerank: false }))
      .toEqual({ ok: false, message: 'Rerank models require a custom upstream' });
    expect(parseModels(serializeModels([{ ...RERANK_MODEL }]), { allowRerank: true }).ok).toBe(true);
  });

  it('rejects a rerank model with no target, which the gateway would refuse', () => {
    const parsed = parseModels('- upstreamModelId: r\n  kind: rerank\n  endpoints:\n    rerank: {}\n', { allowRerank: true });
    expect(parsed.ok).toBe(false);
  });
});
