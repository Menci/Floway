import { describe, expect, it } from 'vitest';

import { buildAgentModelOptions, rankAgentSetupModels } from '../../../src/components/api-keys/agent-setup-models';
import { chatModel } from '../../api/model-fixture';

const model = (id: string, contextWindow = 200_000) => chatModel(id, { contextWindow });

describe('Agent Setup model ranking', () => {
  it('uses segment-aware Claude tiers and retains the full chat catalog', () => {
    expect(rankAgentSetupModels([
      model('claudeish-model'),
      model('vendor/claude-opus-4-8'),
      model('claude-sonnet-4-5'),
      model('gpt-4o'),
      chatModel('embedding', { kind: 'embedding', endpoints: { embeddings: {} } }),
    ], { family: 'claude', picker: 'default' }).map(entry => entry.id)).toEqual([
      'vendor/claude-opus-4-8',
      'claude-sonnet-4-5',
      'claudeish-model',
      'gpt-4o',
    ]);
  });

  it('orders Codex versions and variants without narrowing to GPT-5', () => {
    expect(rankAgentSetupModels([
      model('gpt-4o'),
      model('gpt-5.6-mini'),
      model('gpt-5.6-sol'),
      model('gpt-5.6'),
      model('other'),
    ], { family: 'codex' }).map(entry => entry.id)).toEqual([
      'gpt-4o',
      'gpt-5.6-sol',
      'gpt-5.6',
      'gpt-5.6-mini',
      'other',
    ]);
  });
});

describe('Agent Setup persisted model values', () => {
  it('applies [1m] once and deduplicates convergent values', () => {
    expect(buildAgentModelOptions([
      model('claude-sonnet-4-5', 1_000_000),
      model('claude-sonnet-4-5[1m]', 1_000_000),
    ], { family: 'claude', picker: 'sonnet' })).toEqual([
      { value: 'claude-sonnet-4-5[1m]', publicModelId: 'claude-sonnet-4-5' },
    ]);
  });

  it('offers the window to every Claude picker, and leaves Codex ids opaque', () => {
    expect(buildAgentModelOptions([model('claude-haiku-4-5', 1_000_000)], { family: 'claude', picker: 'haiku' })[0]?.value)
      .toBe('claude-haiku-4-5[1m]');
    expect(buildAgentModelOptions([model('gpt-5.6', 1_000_000)], { family: 'codex' })[0]?.value)
      .toBe('gpt-5.6');
  });

  it('leaves a Claude model that cannot reach the window unsuffixed', () => {
    expect(buildAgentModelOptions([model('claude-haiku-4-5', 200_000)], { family: 'claude', picker: 'haiku' })[0]?.value)
      .toBe('claude-haiku-4-5');
  });
});
