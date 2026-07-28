import { describe, expect, it } from 'vitest';

import type { ControlPlaneModel } from '../../../src/api/types';
import { buildAgentModelOptions, rankAgentSetupModels } from '../../../src/components/api-keys/agent-setup-models';

const model = (id: string, context = 200_000, kind: ControlPlaneModel['kind'] = 'chat'): ControlPlaneModel => ({
  id,
  object: 'model',
  type: 'model',
  display_name: id,
  kind,
  limits: { max_context_window_tokens: context },
  endpoints: kind === 'chat' ? { responses: {} } : { embeddings: {} },
  upstreams: [],
});

describe('Agent Setup model ranking', () => {
  it('uses segment-aware Claude tiers and retains the full chat catalog', () => {
    expect(rankAgentSetupModels([
      model('claudeish-model'),
      model('vendor/claude-opus-4-8'),
      model('claude-sonnet-4-5'),
      model('gpt-4o'),
      model('embedding', 0, 'embedding'),
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
      { value: 'claude-sonnet-4-5[1m]', modelId: 'claude-sonnet-4-5' },
    ]);
  });

  it('keeps Haiku and Codex ids opaque', () => {
    expect(buildAgentModelOptions([model('claude-haiku-4-5', 1_000_000)], { family: 'claude', picker: 'haiku' })[0]?.value)
      .toBe('claude-haiku-4-5');
    expect(buildAgentModelOptions([model('gpt-5.6', 1_000_000)], { family: 'codex' })[0]?.value)
      .toBe('gpt-5.6');
  });
});
