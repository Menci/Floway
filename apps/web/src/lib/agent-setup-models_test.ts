import { describe, expect, it } from 'vitest';

import { buildModelOptions, rankAgentSetupModels } from './agent-setup-models.ts';
import { buildAliasModel, buildRealModel, buildUnlistedModel } from '../api/test-fixtures.ts';

describe('rankAgentSetupModels', () => {
  it('keeps every chat model and drops non-chat kinds', () => {
    const models = [
      buildRealModel({ id: 'gpt-4o' }),
      buildRealModel({ id: 'text-embedding-3-large', kind: 'embedding' }),
      buildRealModel({ id: 'claude-sonnet-4-5' }),
      buildRealModel({ id: 'dall-e-3', kind: 'image' }),
    ];
    const ranked = rankAgentSetupModels(models, { family: 'claude', picker: 'default' });
    expect(ranked.map(m => m.id)).toEqual(['claude-sonnet-4-5', 'gpt-4o']);
  });

  it('orders the Claude default picker by Fable, Opus, Sonnet, Haiku, then other', () => {
    const models = [
      buildRealModel({ id: 'gpt-4o' }),
      buildRealModel({ id: 'claude-sonnet-4-5' }),
      buildAliasModel({ id: 'codex-mini' }),
      buildRealModel({ id: 'claude-haiku-4-5' }),
      buildRealModel({ id: 'some-frontier-model' }),
      buildRealModel({ id: 'claude-opus-4-8' }),
      buildRealModel({ id: 'claude-fable-4-6' }),
    ];
    const ranked = rankAgentSetupModels(models, { family: 'claude', picker: 'default' });
    expect(ranked.map(m => m.id)).toEqual([
      'claude-fable-4-6',
      'claude-opus-4-8',
      'claude-sonnet-4-5',
      'claude-haiku-4-5',
      'gpt-4o',
      'codex-mini',
      'some-frontier-model',
    ]);
  });

  it.each(['opus', 'sonnet', 'haiku'] as const)('moves %s models to the front of the Claude default order', picker => {
    const models = [
      buildRealModel({ id: 'claude-haiku-4-5' }),
      buildRealModel({ id: 'claude-fable-4-6' }),
      buildRealModel({ id: 'claude-opus-4-8' }),
      buildRealModel({ id: 'claude-sonnet-4-5' }),
    ];
    const ranked = rankAgentSetupModels(models, { family: 'claude', picker });
    expect(ranked[0]!.id).toContain(picker);
    expect(ranked.slice(1).map(model => model.id)).toEqual(
      rankAgentSetupModels(models.filter(model => !model.id.includes(picker)), { family: 'claude', picker: 'default' }).map(model => model.id),
    );
  });

  it('stable-sorts gpt-/codex- models first for the Codex family', () => {
    const models = [
      buildRealModel({ id: 'claude-sonnet-4-5' }),
      buildRealModel({ id: 'gpt-5-codex' }),
      buildRealModel({ id: 'some-frontier-model' }),
      buildUnlistedModel({ id: 'codex-mini' }),
    ];
    const ranked = rankAgentSetupModels(models, { family: 'codex' });
    expect(ranked.map(m => m.id)).toEqual([
      'gpt-5-codex',
      'claude-sonnet-4-5',
      'some-frontier-model',
      'codex-mini',
    ]);
  });

  it('orders variants of the same GPT version as sol, terra, luna, plain, mini, nano, then other suffixes', () => {
    const models = [
      buildRealModel({ id: 'gpt-5.6-preview' }),
      buildRealModel({ id: 'gpt-5.6-mini' }),
      buildRealModel({ id: 'gpt-5.6' }),
      buildRealModel({ id: 'gpt-5.6-luna' }),
      buildRealModel({ id: 'gpt-5.6-nano' }),
      buildRealModel({ id: 'gpt-5.6-sol' }),
      buildRealModel({ id: 'gpt-5.6-terra' }),
    ];
    expect(rankAgentSetupModels(models, { family: 'codex' }).map(model => model.id)).toEqual([
      'gpt-5.6-sol',
      'gpt-5.6-terra',
      'gpt-5.6-luna',
      'gpt-5.6',
      'gpt-5.6-mini',
      'gpt-5.6-nano',
      'gpt-5.6-preview',
    ]);
  });

  it('keeps Codex version groups stable while ordering variants within each group', () => {
    const models = [
      buildRealModel({ id: 'gpt-5-mini' }),
      buildRealModel({ id: 'gpt-6' }),
      buildRealModel({ id: 'gpt-5-sol' }),
    ];
    expect(rankAgentSetupModels(models, { family: 'codex' }).map(model => model.id)).toEqual([
      'gpt-5-sol',
      'gpt-5-mini',
      'gpt-6',
    ]);
  });

  it('treats a prefixed addressable id as native by its trailing family token', () => {
    const models = [
      buildRealModel({ id: 'openrouter/claude-3-opus' }),
      buildRealModel({ id: 'gpt-4o' }),
    ];
    expect(rankAgentSetupModels(models, { family: 'claude', picker: 'default' }).map(m => m.id)).toEqual([
      'openrouter/claude-3-opus',
      'gpt-4o',
    ]);
  });

  it('does not promote near-miss Claude ids without a claude- segment', () => {
    const models = [
      buildRealModel({ id: 'claudeish-model' }),
      buildRealModel({ id: 'vendor/my-claude-sonnet' }),
      buildRealModel({ id: 'vendor/claude-opus-4-8' }),
      buildRealModel({ id: 'claude-sonnet-4-5' }),
    ];
    expect(rankAgentSetupModels(models, { family: 'claude', picker: 'default' }).map(m => m.id)).toEqual([
      'vendor/claude-opus-4-8',
      'claude-sonnet-4-5',
      'claudeish-model',
      'vendor/my-claude-sonnet',
    ]);
  });

  it('promotes every gpt- segment for Codex and keeps non-GPT models behind it', () => {
    const models = [
      buildRealModel({ id: 'gpt-4o' }),
      buildRealModel({ id: 'gpt-50-preview' }),
      buildRealModel({ id: 'vendor/my-codex-model' }),
      buildRealModel({ id: 'vendor/gpt-5.6-codex' }),
      buildRealModel({ id: 'codex-mini' }),
    ];
    expect(rankAgentSetupModels(models, { family: 'codex' }).map(m => m.id)).toEqual([
      'gpt-4o',
      'gpt-50-preview',
      'vendor/gpt-5.6-codex',
      'vendor/my-codex-model',
      'codex-mini',
    ]);
  });

  it('removes duplicate ids, keeping the first occurrence', () => {
    const models = [
      buildRealModel({ id: 'claude-sonnet-4-5', display_name: 'first' }),
      buildRealModel({ id: 'gpt-4o' }),
      buildAliasModel({ id: 'claude-sonnet-4-5', display_name: 'second' }),
    ];
    const ranked = rankAgentSetupModels(models, { family: 'claude', picker: 'default' });
    expect(ranked.map(m => m.id)).toEqual(['claude-sonnet-4-5', 'gpt-4o']);
    expect(ranked[0]!.display_name).toBe('first');
  });
});

describe('buildModelOptions', () => {
  it('derives Claude option values through the [1m] rule while keeping the raw id as the display', () => {
    const options = buildModelOptions([
      buildRealModel({ id: 'claude-sonnet-4-5', limits: { max_context_window_tokens: 1_000_000 } }),
      buildRealModel({ id: 'claude-haiku-4-5', limits: { max_context_window_tokens: 200_000 } }),
    ], { family: 'claude', picker: 'default' });
    expect(options).toEqual([
      { value: 'claude-sonnet-4-5[1m]', modelId: 'claude-sonnet-4-5' },
      { value: 'claude-haiku-4-5', modelId: 'claude-haiku-4-5' },
    ]);
  });

  it('keeps Haiku ids plain even when the catalog advertises a one-million-token window', () => {
    const options = buildModelOptions([
      buildRealModel({ id: 'claude-haiku-4-5', limits: { max_context_window_tokens: 1_000_000 } }),
    ], { family: 'claude', picker: 'haiku' });
    expect(options[0]).toEqual({ value: 'claude-haiku-4-5', modelId: 'claude-haiku-4-5' });
  });

  it('keeps raw ids for the Codex family and never applies [1m]', () => {
    const options = buildModelOptions([
      buildRealModel({ id: 'gpt-5-codex', limits: { max_context_window_tokens: 1_000_000 } }),
    ], { family: 'codex' });
    expect(options).toEqual([{ value: 'gpt-5-codex', modelId: 'gpt-5-codex' }]);
  });

  it('sums split prompt/output caps when no combined window is published, then applies [1m]', () => {
    const options = buildModelOptions([
      buildRealModel({ id: 'claude-sonnet-4-5', limits: { max_prompt_tokens: 900_000, max_output_tokens: 100_000 } }),
    ], { family: 'claude', picker: 'default' });
    expect(options[0]).toEqual({ value: 'claude-sonnet-4-5[1m]', modelId: 'claude-sonnet-4-5' });
  });

  it('never double-suffixes a catalog id that already carries [1m]', () => {
    const options = buildModelOptions([
      buildRealModel({ id: 'claude-sonnet-4-5[1m]', limits: { max_context_window_tokens: 1_000_000 } }),
    ], { family: 'claude', picker: 'default' });
    expect(options[0]!.value).toBe('claude-sonnet-4-5[1m]');
  });

  it('deduplicates option values when raw and pre-suffixed Claude ids converge', () => {
    const options = buildModelOptions([
      buildRealModel({ id: 'claude-sonnet-4-5', limits: { max_context_window_tokens: 1_000_000 } }),
      buildRealModel({ id: 'claude-sonnet-4-5[1m]', limits: { max_context_window_tokens: 1_000_000 } }),
    ], { family: 'claude', picker: 'sonnet' });
    expect(options).toEqual([
      { value: 'claude-sonnet-4-5[1m]', modelId: 'claude-sonnet-4-5' },
    ]);
  });
});
