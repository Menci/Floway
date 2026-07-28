import { describe, expect, it } from 'vitest';

import type { AliasTarget, ControlPlaneModel, ModelAlias } from '../../../src/api/types';
import { computeAnnouncedMetadata } from '../../../src/components/model-alias/announced-metadata';
import { aliasBody, aliasDefaults, metadataForKind } from '../../../src/components/model-alias/form-data';
import { mergeModelAliasesPageData } from '../../../src/components/model-alias/load-data';
import { computeAliasWarnings, computeModelWarning, computeRuleWarnings, findCatalogModel } from '../../../src/components/model-alias/warnings';

const model = (id: string, extra: Partial<ControlPlaneModel> = {}): ControlPlaneModel => ({
  id, object: 'model', type: 'model', display_name: id, kind: 'chat',
  endpoints: { chatCompletions: {} }, limits: {}, upstreams: [], ...extra,
});
const target = (id: string, rules: AliasTarget['rules'] = {}): AliasTarget => ({ target_model_id: id, rules });

describe('model alias page data', () => {
  it('keeps aliases usable when the model catalog fails', () => {
    const alias = aliasDefaultsToRecord('virtual');
    const result = mergeModelAliasesPageData(
      { aliases: [], models: null },
      { data: [alias] },
      { error: { status: 503, message: 'catalog unavailable' } },
    );

    expect(result).toEqual({
      aliases: [alias],
      models: null,
      aliasError: null,
      modelsError: 'catalog unavailable',
    });
  });

  it('retains the previous catalog across a temporary reload failure', () => {
    const catalog = [model('stable')];
    const result = mergeModelAliasesPageData(
      { aliases: [], models: catalog },
      { data: [] },
      { error: { status: 503, message: 'catalog unavailable' } },
    );

    expect(result.models).toBe(catalog);
  });
});

const aliasDefaultsToRecord = (name: string): ModelAlias => ({
  name, kind: 'chat', selection: 'first-available', display_name: null,
  visible_in_models_list: true, targets: [target('a')], announced_metadata: null,
  sort_order: 0, created_at: '2026-01-01', updated_at: '2026-01-01',
});

describe('model alias warnings', () => {
  it('never treats an alias catalog row as a real target', () => {
    const aliasRow = model('virtual', { aliasedFrom: { selection: 'first-available', targets: [] } });
    expect(findCatalogModel([aliasRow], 'virtual')).toBeUndefined();
    expect(computeModelWarning('virtual', undefined, 'chat')?.key).toBe('unknownTarget');
  });

  it('reports shadow and unreachable-target warnings independently', () => {
    const catalog = [model('gpt-5', { display_name: 'GPT 5' })];
    expect(computeAliasWarnings({ name: 'gpt-5', targets: [target('missing')] }, catalog).map(warning => warning.type)).toEqual(['shadow', 'no-target']);
    expect(computeAliasWarnings({ name: 'gpt-5', targets: [target('gpt-5')] }, catalog)).toEqual([]);
    expect(computeAliasWarnings({ name: 'fresh', targets: [target('missing')] }, null)).toEqual([]);
  });

  it('warns when pinned rules exceed advertised capabilities', () => {
    const catalog = model('reasoner', { chat: { reasoning: { effort: { supported: ['low'], default: 'low' }, budget_tokens: { min: 100, max: 1000 } } } });
    const warnings = computeRuleWarnings({ reasoning: { effort: 'high', budget_tokens: 5000, adaptive: true } }, catalog);
    expect(warnings.map(warning => warning.key)).toEqual(expect.arrayContaining(['unsupportedEffort', 'adaptiveBudgetConflict', 'budgetAbove', 'notAdvertisedAdaptive']));
  });
});

describe('announced metadata', () => {
  it('intersects limits, modalities, and effort across reachable targets', () => {
    const result = computeAnnouncedMetadata([target('a'), target('b')], 'chat', [
      model('a', { limits: { max_context_window_tokens: 200000 }, chat: { modalities: { input: ['text', 'image'], output: ['text'] }, reasoning: { effort: { supported: ['low', 'medium'], default: 'medium' } } } }),
      model('b', { limits: { max_context_window_tokens: 128000 }, chat: { modalities: { input: ['text'], output: ['text'] }, reasoning: { effort: { supported: ['low'], default: 'low' } } } }),
    ]);
    expect(result.limits).toEqual({ max_context_window_tokens: 128000 });
    expect(result.chat?.modalities).toEqual({ input: ['text'], output: ['text'] });
    expect(result.chat?.reasoning?.effort).toEqual({ supported: ['low'], default: 'low' });
  });

  it('removes a capability from the intersection when a target rule pins it', () => {
    const result = computeAnnouncedMetadata([target('a', { reasoning: { effort: 'low' } })], 'chat', [
      model('a', { chat: { reasoning: { effort: { supported: ['low', 'medium'], default: 'medium' } } } }),
    ]);
    expect(result.chat?.reasoning).toBeUndefined();
  });
});

describe('alias wire body', () => {
  const existing: ModelAlias = {
    name: 'old', kind: 'chat', selection: 'first-available', display_name: null,
    visible_in_models_list: true, targets: [target('a')], announced_metadata: null,
    sort_order: 7, created_at: '2026-01-01', updated_at: '2026-01-01',
  };

  it('drops chat-only metadata when the alias changes to a non-chat kind', () => {
    expect(metadataForKind('rerank', {
      limits: { max_context_window_tokens: 4096 },
      chat: { modalities: { input: ['text'], output: ['text'] } },
    })).toEqual({ limits: { max_context_window_tokens: 4096 } });
  });

  it('trims identifiers and preserves sort order while normalizing empty fields', () => {
    const values = aliasDefaults(existing);
    values.name = ' renamed '; values.displayName = ' ';
    values.targets = [target(' a ', { reasoning: {}, verbosity: '' })];
    expect(aliasBody(values, existing)).toMatchObject({ name: 'renamed', display_name: null, sort_order: 7, targets: [{ target_model_id: 'a', rules: {} }] });
  });

  it('drops chat rules and announced metadata for image aliases', () => {
    const values = aliasDefaults(existing);
    values.kind = 'image'; values.manualMetadata = true;
    values.targets = [target('image-1', { verbosity: 'high' })];
    values.announcedMetadata = { limits: { max_output_tokens: 10 } };
    expect(aliasBody(values, existing)).toMatchObject({ targets: [{ rules: {} }], announced_metadata: null });
  });
});
