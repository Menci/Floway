import { describe, expect, it } from 'vitest';

import { isOmpUserAgent, toOmpCatalog, toOmpModel } from '../../../src/data-plane/models/omp-catalog.ts';
import { type PublicModel, tokenBasePricing } from '@floway-dev/protocols/common';

const model: PublicModel = {
  id: 'operator-alias', object: 'model', type: 'model', display_name: 'Operator Alias',
  kind: 'chat', endpoints: { openaiChatCompletions: {} },
  limits: { max_context_window_tokens: 128_000, max_prompt_tokens: 100_000, max_output_tokens: 16_384 },
  opaqueBlobCompatibilityScope: { bindToUpstream: true },
  chat: { modalities: { input: ['text', 'image'], output: ['text'] }, reasoning: { effort: { supported: ['low', 'medium', 'high'], default: 'medium' }, mandatory: true } },
  pricing: tokenBasePricing({ input_tokens: '2', output_tokens: '8', input_cache_read_tokens: '0.2', input_cache_write_tokens: '0' }),
};

describe('OMP model declarations', () => {
  it('matches the host User-Agent and rejects lookalikes', () => {
    expect(isOmpUserAgent('omp/18.8.4')).toBe(true);
    for (const agent of [undefined, '', 'omp', 'not-omp/18.8.4', 'floway-omp/1', 'claude-code/2.1.206']) expect(isOmpUserAgent(agent)).toBe(false);
  });

  it('gives arbitrary aliases exact prices, limits, modalities, default and mandatory reasoning', () => {
    expect(toOmpModel(model, 'floway')).toEqual({
      id: 'operator-alias', name: 'Operator Alias', kind: 'chat', api: 'floway:floway', reasoning: true,
      thinking: { mode: 'effort', efforts: ['low', 'medium', 'high'], defaultLevel: 'medium', requiresEffort: true },
      input: ['text', 'image'], contextWindow: 128_000, maxTokens: 16_384,
      cost: { input: 2, output: 8, cacheRead: 0.2, cacheWrite: 0 },
      compat: { supportsReasoningEffort: true, supportsDeveloperRole: true, supportsStore: false },
    });
  });

  it('exposes a missing Base entry in defined pricing', () => {
    expect(() => toOmpModel({ ...model, pricing: { entries: [] } }, 'floway')).toThrow();
  });

  it('keeps reasoning off available when the endpoint does not require reasoning', () => {
    const projected = toOmpModel({ ...model, chat: { reasoning: { effort: { supported: ['low', 'high'], default: 'low' }, mandatory: false } } }, 'floway');
    expect(projected?.thinking?.requiresEffort).toBe(false);
    expect(projected?.thinking?.efforts).toEqual(['low', 'high']);
  });

  it('routes budget and adaptive controls through Anthropic Messages', () => {
    const budget = toOmpModel({ ...model, chat: { reasoning: { budget_tokens: { min: 1024, max: 32768 } } } }, 'floway');
    expect(budget?.api).toBe('floway:floway');
    expect(budget?.thinking?.mode).toBe('budget');
    const adaptive = toOmpModel({ ...model, chat: { reasoning: { adaptive: true, effort: { supported: ['low', 'high'], default: 'high' } } } }, 'floway');
    expect(adaptive?.api).toBe('floway:floway');
    expect(adaptive?.thinking?.mode).toBe('anthropic-adaptive');
  });

  it('does not invent reasoning or limits when the endpoint declares none', () => {
    const projected = toOmpModel({ ...model, chat: undefined, limits: {}, pricing: undefined }, 'floway');
    expect(projected?.reasoning).toBe(false);
    expect(projected?.thinking).toBeUndefined();
    expect(projected?.contextWindow).toBe(128000);
    expect(projected?.maxTokens).toBe(16384);
    expect(projected?.cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  });

  it('registers supported auxiliary runners and omits unsupported endpoint families', () => {
    const data = [
      model,
      { ...model, id: 'embedding', kind: 'embedding' as const, endpoints: { openaiEmbeddings: {} }, chat: undefined },
      { ...model, id: 'image', kind: 'image' as const, endpoints: { openaiImagesGenerations: {} }, chat: undefined },
      { ...model, id: 'rerank', kind: 'rerank' as const },
      { ...model, id: 'transcription', kind: 'transcription' as const },
    ];
    const catalog = toOmpCatalog({ object: 'list', has_more: false, first_id: model.id, last_id: 'transcription', data }, 'https://gateway.example', 'floway');
    expect(catalog.api).toBe('floway:floway');
    expect(catalog.models.map(item => [item.id, item.api])).toEqual([['operator-alias', 'floway:floway'], ['embedding', 'openai-embeddings'], ['image', 'openai-images']]);
  });

  it('preserves explicitly advertised original image detail', () => {
    expect(toOmpModel({ ...model, chat: { ...model.chat, image_detail_original: true } }, 'floway')?.compat.supportsImageDetailOriginal).toBe(true);
  });

  it('keeps mandatory-only reasoning enabled without fabricating a wire effort', () => {
    const projected = toOmpModel({ ...model, chat: { reasoning: { mandatory: true } } }, 'floway');
    expect(projected?.thinking).toEqual({ mode: 'effort', efforts: ['minimal'], requiresEffort: true });
    expect(projected?.compat.supportsReasoningEffort).toBe(false);
  });

  it('reports contradictory output and mandatory budget constraints', () => {
    expect(() => toOmpCatalog({ object: 'list', has_more: false, first_id: model.id, last_id: model.id, data: [{ ...model, limits: { max_output_tokens: 8000 }, chat: { reasoning: { budget_tokens: { min: 6000 }, mandatory: true } } }] }, 'https://gateway.example', 'floway')).toThrow('reasoning budget does not fit its output limit');
  });

  it('maps every unknown wire effort onto a distinct supported UI slot', () => {
    const projected = toOmpModel({ ...model, chat: { reasoning: { effort: { supported: ['fast', 'balanced', 'deep'], default: 'balanced' } } } }, 'floway');
    expect(projected?.thinking).toEqual({ mode: 'effort', efforts: ['minimal', 'low', 'medium'], defaultLevel: 'medium', effortMap: { minimal: 'fast', low: 'deep', medium: 'balanced' }, requiresEffort: false });
    expect(projected?.compat.reasoningEffortMap).toEqual({ minimal: 'fast', low: 'deep', medium: 'balanced' });
    const collision = toOmpModel({ ...model, chat: { reasoning: { effort: { supported: ['low', 'balanced', 'deep'], default: 'balanced' } } } }, 'floway');
    expect(collision?.thinking?.effortMap).toEqual({ minimal: 'deep', medium: 'balanced' });
  });

  it('reports a model-specific error rather than dropping a seventh selectable tier', () => {
    expect(() => toOmpModel({ ...model, chat: { reasoning: { effort: { supported: ['a', 'b', 'c', 'd', 'e', 'f', 'g'], default: 'a' } } } }, 'floway')).toThrow('Cannot adapt OMP model "operator-alias"');
  });

  it('clamps budget presets to declared bounds and chooses protocol URLs on the server', () => {
    const budgetModel = { ...model, limits: { max_output_tokens: 12000 }, chat: { reasoning: { budget_tokens: { min: 1000, max: 1100 }, mandatory: true } } };
    const catalog = toOmpCatalog({ object: 'list', has_more: false, first_id: model.id, last_id: model.id, data: [budgetModel] }, 'https://gateway.example/gateway', 'floway');
    expect(catalog.models[0].baseUrl).toBe('https://gateway.example/gateway');
    expect(catalog.wireApis[model.id]).toBe('anthropic-messages');
    expect(catalog.streamOptions[model.id].thinkingBudgets).toEqual({ minimal: 1024, low: 1100, medium: 1100, high: 1100, xhigh: 1100, max: 1100 });
    expect(catalog.models[0].thinking?.requiresEffort).toBe(true);
  });

  it('keeps adaptive-only thinking model-controlled without an invented effort', () => {
    const adaptive = { ...model, chat: { reasoning: { adaptive: true } } };
    const catalog = toOmpCatalog({ object: 'list', has_more: false, first_id: model.id, last_id: model.id, data: [adaptive] }, 'https://gateway.example', 'floway');
    expect(catalog.models[0].thinking).toEqual({ mode: 'anthropic-adaptive', efforts: ['high'], requiresEffort: false });
    expect(catalog.payloadRemovals[model.id]).toEqual([['output_config', 'effort']]);
  });

  it('keeps an empty authorized roster empty', () => {
    expect(toOmpCatalog({ object: 'list', has_more: false, first_id: null, last_id: null, data: [] }, 'https://gateway.example', 'floway')).toEqual({ api: 'floway:floway', models: [], wireApis: {}, streamOptions: {}, payloadRemovals: {} });
  });
});

it('isolates custom API registrations for independently named providers', () => {
  const catalog = toOmpCatalog({ object: 'list', has_more: false, first_id: model.id, last_id: model.id, data: [model] }, 'https://gateway.example', 'personal');
  expect(catalog.api).toBe('floway:personal');
  expect(catalog.models[0].api).toBe('floway:personal');
  expect(catalog.models[0].id).toBe(model.id);
});
