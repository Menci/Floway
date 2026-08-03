import { describe, expect, it } from 'vitest';

import { computeAnnouncedMetadata } from '../../../src/components/model-alias/announced-metadata';
import { aliasBody, aliasDefaults, metadataForKind } from '../../../src/components/model-alias/form-data';
import { computeAliasWarnings, computeModelWarning, computeRuleWarnings } from '../../../src/components/model-alias/warnings';
import { indexCatalog } from '../../../src/components/models/catalog-index';
import { catalogModel } from '../../api/model-fixture';
import type { AliasTarget, ModelAlias } from '@floway-dev/protocols/common';
const target = (id: string, rules: AliasTarget['rules'] = {}): AliasTarget => ({ target_model_id: id, rules });

describe('model alias warnings', () => {
  it('never treats an alias catalog row as a real target', () => {
    const aliasRow = catalogModel('virtual', { aliasedFrom: { selection: 'first-available', targets: [] } });
    expect(indexCatalog([aliasRow]).get('virtual')).toBeUndefined();
    expect(computeModelWarning('virtual', undefined, 'chat')?.key).toBe('unknownTarget');
  });

  it('reports shadow and unreachable-target warnings independently', () => {
    const catalog = indexCatalog([catalogModel('gpt-5', { display_name: 'GPT 5' })]);
    expect(computeAliasWarnings({ name: 'gpt-5', targets: [target('missing')] }, catalog).map(warning => warning.type)).toEqual(['shadow', 'no-target']);
    expect(computeAliasWarnings({ name: 'gpt-5', targets: [target('gpt-5')] }, catalog)).toEqual([]);
    expect(computeAliasWarnings({ name: 'fresh', targets: [target('missing')] }, null)).toEqual([]);
  });

  it('says nothing about a target nobody has entered yet', () => {
    // A new alias opens on one blank row, so no target resolves by
    // construction; reporting that is reporting the starting state as a fault.
    const catalog = indexCatalog([catalogModel('gpt-5')]);
    expect(computeAliasWarnings({ name: '', targets: [target('')] }, catalog)).toEqual([]);
    expect(computeAliasWarnings({ name: '', targets: [target(''), target('')] }, catalog)).toEqual([]);
    expect(computeAliasWarnings({ name: '', targets: [target(''), target('missing')] }, catalog).map(warning => warning.type))
      .toEqual(['no-target']);
  });

  it('warns when pinned rules exceed advertised capabilities', () => {
    const catalog = catalogModel('reasoner', { chat: { reasoning: { effort: { supported: ['low'], default: 'low' }, budget_tokens: { min: 100, max: 1000 } } } });
    const warnings = computeRuleWarnings({ reasoning: { effort: 'high', budget_tokens: 5000, adaptive: true } }, catalog);
    expect(warnings.map(warning => warning.key).toSorted())
      .toEqual(['adaptiveBudgetConflict', 'budgetAbove', 'notAdvertisedAdaptive', 'unsupportedEffort']);
  });
});

describe('announced metadata', () => {
  it('intersects limits, modalities, and effort across reachable targets', () => {
    const result = computeAnnouncedMetadata([target('a'), target('b')], 'chat', indexCatalog([
      catalogModel('a', { contextWindow: 200000, chat: { modalities: { input: ['text', 'image'], output: ['text'] }, reasoning: { effort: { supported: ['low', 'medium'], default: 'medium' } } } }),
      catalogModel('b', { contextWindow: 128000, chat: { modalities: { input: ['text'], output: ['text'] }, reasoning: { effort: { supported: ['low'], default: 'low' } } } }),
    ]));
    expect(result.limits).toEqual({ max_context_window_tokens: 128000 });
    expect(result.chat?.modalities).toEqual({ input: ['text'], output: ['text'] });
    expect(result.chat?.reasoning?.effort).toEqual({ supported: ['low'], default: 'low' });
  });

  it('removes a capability from the intersection when a target rule pins it', () => {
    const result = computeAnnouncedMetadata([target('a', { reasoning: { effort: 'low' } })], 'chat', indexCatalog([
      catalogModel('a', { chat: { reasoning: { effort: { supported: ['low', 'medium'], default: 'medium' } } } }),
    ]));
    expect(result.chat?.reasoning).toBeUndefined();
  });
});

describe('alias wire body', () => {
  const existing: ModelAlias = {
    id: 'alias_old', name: 'old', kind: 'chat', selection: 'first-available', display_name: null,
    visible_in_models_list: true, targets: [target('a')], announced_metadata: null,
    sort_order: 7, created_at: '2026-01-01', updated_at: '2026-01-01',
  };

  it('drops chat-only metadata when the alias changes to a non-chat kind', () => {
    expect(metadataForKind('rerank', {
      limits: { max_context_window_tokens: 4096 },
      chat: { modalities: { input: ['text'], output: ['text'] } },
    })).toEqual({ limits: { max_context_window_tokens: 4096 } });
  });

  it('trims identifiers and normalizes empty fields, leaving the order to the server', () => {
    const values = aliasDefaults(existing);
    values.name = ' renamed '; values.displayName = ' ';
    values.targets = [target(' a ', { reasoning: {}, verbosity: '' })];
    const body = aliasBody(values);
    expect(body).toMatchObject({ name: 'renamed', display_name: null, targets: [{ target_model_id: 'a', rules: {} }] });
    expect(body).not.toHaveProperty('sort_order');
  });

  it('drops chat rules and announced metadata for image aliases', () => {
    const values = aliasDefaults(existing);
    values.kind = 'image'; values.manualMetadata = true;
    values.targets = [target('image-1', { verbosity: 'high' })];
    values.announcedMetadata = { limits: { max_output_tokens: 10 } };
    expect(aliasBody(values)).toMatchObject({ targets: [{ rules: {} }], announced_metadata: null });
  });
});
