import { describe, expect, it } from 'vitest';

import { buildAgentModelOptions, rankAgentSetupModels } from '../../../src/components/api-keys/agent-setup-models';
import { catalogModel } from '../../api/model-fixture';

describe('Agent Setup model ranking', () => {
  it('uses segment-aware Claude tiers and retains the full chat catalog', () => {
    expect(rankAgentSetupModels([
      catalogModel('claudeish-model', { contextWindow: 200_000 }),
      catalogModel('vendor/claude-opus-4-8', { contextWindow: 200_000 }),
      catalogModel('claude-sonnet-4-5', { contextWindow: 200_000 }),
      catalogModel('gpt-4o', { contextWindow: 200_000 }),
      catalogModel('embedding', { kind: 'embedding', endpoints: { openaiEmbeddings: {} } }),
    ], { family: 'claude', picker: 'default' }).map(entry => entry.id)).toEqual([
      'vendor/claude-opus-4-8',
      'claude-sonnet-4-5',
      'claudeish-model',
      'gpt-4o',
    ]);
  });

  it('orders Codex versions and variants without narrowing to GPT-5', () => {
    expect(rankAgentSetupModels([
      catalogModel('gpt-4o', { contextWindow: 200_000 }),
      catalogModel('gpt-5.6-mini', { contextWindow: 200_000 }),
      catalogModel('gpt-5.6-sol', { contextWindow: 200_000 }),
      catalogModel('gpt-5.6', { contextWindow: 200_000 }),
      catalogModel('other', { contextWindow: 200_000 }),
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
      catalogModel('claude-sonnet-4-5', { contextWindow: 1_000_000 }),
      catalogModel('claude-sonnet-4-5[1m]', { contextWindow: 1_000_000 }),
    ], { family: 'claude', picker: 'sonnet' })).toEqual([
      { value: 'claude-sonnet-4-5[1m]', label: 'claude-sonnet-4-5' },
    ]);
  });
});
