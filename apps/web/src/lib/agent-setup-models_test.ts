import { describe, expect, it } from 'vitest';

import {
  applyClaudeContextSuffix,
  buildModelOptions,
  codexEffortSuggestions,
  MODEL_OVERRIDE_NONE,
  normalizeEffortInput,
  rankAgentSetupModels,
} from './agent-setup-models.ts';
import { buildAliasModel, buildRealModel, buildUnlistedModel } from '../api/test-fixtures.ts';

describe('rankAgentSetupModels', () => {
  it('keeps every chat model and drops non-chat kinds', () => {
    const models = [
      buildRealModel({ id: 'gpt-4o' }),
      buildRealModel({ id: 'text-embedding-3-large', kind: 'embedding' }),
      buildRealModel({ id: 'claude-sonnet-4-5' }),
      buildRealModel({ id: 'dall-e-3', kind: 'image' }),
    ];
    const ranked = rankAgentSetupModels(models, 'claude');
    expect(ranked.map(m => m.id)).toEqual(['claude-sonnet-4-5', 'gpt-4o']);
  });

  it('stable-sorts Claude-family models first while preserving source order in each bucket', () => {
    const models = [
      buildRealModel({ id: 'gpt-4o' }),
      buildRealModel({ id: 'claude-sonnet-4-5' }),
      buildAliasModel({ id: 'codex-mini' }),
      buildRealModel({ id: 'some-frontier-model' }),
      buildRealModel({ id: 'claude-opus-4-8' }),
    ];
    const ranked = rankAgentSetupModels(models, 'claude');
    expect(ranked.map(m => m.id)).toEqual([
      'claude-sonnet-4-5',
      'claude-opus-4-8',
      'gpt-4o',
      'codex-mini',
      'some-frontier-model',
    ]);
  });

  it('stable-sorts gpt-/codex- models first for the Codex family', () => {
    const models = [
      buildRealModel({ id: 'claude-sonnet-4-5' }),
      buildRealModel({ id: 'gpt-5-codex' }),
      buildRealModel({ id: 'some-frontier-model' }),
      buildUnlistedModel({ id: 'codex-mini' }),
    ];
    const ranked = rankAgentSetupModels(models, 'codex');
    expect(ranked.map(m => m.id)).toEqual([
      'gpt-5-codex',
      'codex-mini',
      'claude-sonnet-4-5',
      'some-frontier-model',
    ]);
  });

  it('treats a prefixed addressable id as native by its trailing family token', () => {
    const models = [
      buildRealModel({ id: 'openrouter/claude-3-opus' }),
      buildRealModel({ id: 'gpt-4o' }),
    ];
    expect(rankAgentSetupModels(models, 'claude').map(m => m.id)).toEqual([
      'openrouter/claude-3-opus',
      'gpt-4o',
    ]);
  });

  it('removes duplicate ids, keeping the first occurrence', () => {
    const models = [
      buildRealModel({ id: 'claude-sonnet-4-5', display_name: 'first' }),
      buildRealModel({ id: 'gpt-4o' }),
      buildAliasModel({ id: 'claude-sonnet-4-5', display_name: 'second' }),
    ];
    const ranked = rankAgentSetupModels(models, 'claude');
    expect(ranked.map(m => m.id)).toEqual(['claude-sonnet-4-5', 'gpt-4o']);
    expect(ranked[0]!.display_name).toBe('first');
  });
});

describe('applyClaudeContextSuffix', () => {
  it('appends [1m] once a model advertises a one-million-token window', () => {
    expect(applyClaudeContextSuffix('claude-sonnet-4-5', { max_context_window_tokens: 1_000_000 }))
      .toBe('claude-sonnet-4-5[1m]');
  });

  it('sums split prompt/output caps when no combined window is published', () => {
    expect(applyClaudeContextSuffix('claude-sonnet-4-5', { max_prompt_tokens: 900_000, max_output_tokens: 100_000 }))
      .toBe('claude-sonnet-4-5[1m]');
  });

  it('leaves smaller windows untouched and never double-suffixes', () => {
    expect(applyClaudeContextSuffix('claude-sonnet-4-5', { max_context_window_tokens: 200_000 }))
      .toBe('claude-sonnet-4-5');
    expect(applyClaudeContextSuffix('claude-sonnet-4-5[1m]', { max_context_window_tokens: 1_000_000 }))
      .toBe('claude-sonnet-4-5[1m]');
  });
});

describe('buildModelOptions', () => {
  it('always exposes a nullable "no override" option first', () => {
    const options = buildModelOptions([buildRealModel({ id: 'claude-sonnet-4-5' })], null, 'claude');
    expect(options[0]).toEqual({ value: MODEL_OVERRIDE_NONE, modelId: null, unavailable: false });
  });

  it('derives Claude option values through the [1m] rule while keeping the raw id as the display', () => {
    const options = buildModelOptions([
      buildRealModel({ id: 'claude-sonnet-4-5', limits: { max_context_window_tokens: 1_000_000 } }),
      buildRealModel({ id: 'claude-haiku-4-5', limits: { max_context_window_tokens: 200_000 } }),
    ], null, 'claude');
    expect(options.slice(1)).toEqual([
      { value: 'claude-sonnet-4-5[1m]', modelId: 'claude-sonnet-4-5', unavailable: false },
      { value: 'claude-haiku-4-5', modelId: 'claude-haiku-4-5', unavailable: false },
    ]);
  });

  it('keeps raw ids for the Codex family and never applies [1m]', () => {
    const options = buildModelOptions([
      buildRealModel({ id: 'gpt-5-codex', limits: { max_context_window_tokens: 1_000_000 } }),
    ], null, 'codex');
    expect(options.slice(1)).toEqual([
      { value: 'gpt-5-codex', modelId: 'gpt-5-codex', unavailable: false },
    ]);
  });

  it('preserves a restored value missing from the catalog as an unavailable-current option', () => {
    const options = buildModelOptions(
      [buildRealModel({ id: 'claude-sonnet-4-5' })],
      'claude-retired[1m]',
      'claude',
    );
    expect(options.find(o => o.unavailable)).toEqual({
      value: 'claude-retired[1m]',
      modelId: 'claude-retired[1m]',
      unavailable: true,
    });
  });

  it('does not add an unavailable option when the restored value is already listed', () => {
    const options = buildModelOptions(
      [buildRealModel({ id: 'claude-sonnet-4-5', limits: { max_context_window_tokens: 1_000_000 } })],
      'claude-sonnet-4-5[1m]',
      'claude',
    );
    expect(options.some(o => o.unavailable)).toBe(false);
  });

  it('treats the empty sentinel as "no override" without adding an unavailable option', () => {
    const options = buildModelOptions([buildRealModel({ id: 'claude-sonnet-4-5' })], MODEL_OVERRIDE_NONE, 'claude');
    expect(options.some(o => o.unavailable)).toBe(false);
  });
});

describe('codexEffortSuggestions', () => {
  it('returns the supported efforts in metadata order', () => {
    const model = buildRealModel({
      id: 'gpt-5-codex',
      chat: { reasoning: { effort: { supported: ['low', 'medium', 'high'], default: 'medium' } } },
    });
    expect(codexEffortSuggestions(model)).toEqual(['low', 'medium', 'high']);
  });

  it('returns an empty list when the model advertises no effort metadata', () => {
    expect(codexEffortSuggestions(buildRealModel({ id: 'gpt-5-codex' }))).toEqual([]);
    expect(codexEffortSuggestions(undefined)).toEqual([]);
  });
});

describe('normalizeEffortInput', () => {
  it('maps blank input to null', () => {
    expect(normalizeEffortInput('')).toBeNull();
    expect(normalizeEffortInput('   ')).toBeNull();
  });

  it('retains an arbitrary non-empty value verbatim after trimming surrounding whitespace', () => {
    expect(normalizeEffortInput('ultra')).toBe('ultra');
    expect(normalizeEffortInput('  high  ')).toBe('high');
  });
});
