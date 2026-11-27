import { describe, expect, test } from 'vitest';

import {
  buildClaudeCodeCatalog,
  chatFromCapabilities,
  fetchClaudeCodeModelsList,
  type ClaudeCodeApiModel,
  type ClaudeCodeUpstreamData,
} from '../src/models.ts';
import { UpstreamModelsUnavailableError, type FlagId } from '@floway-dev/upstream';

test('catalog fetch exposes the upstream HTTP failure', async () => {
  try {
    await fetchClaudeCodeModelsList('at', async () => new Response('{"error":"denied"}', { status: 401, headers: { 'retry-after': '30' } }));
    throw new Error('catalog fetch unexpectedly succeeded');
  } catch (error) {
    expect(error).toBeInstanceOf(UpstreamModelsUnavailableError);
    expect((error as UpstreamModelsUnavailableError).displayResponse).toMatchObject({
      status: 401,
      body: '{\n  "error": "denied"\n}',
      headers: expect.arrayContaining([['retry-after', '30']]),
    });
  }
});

test('malformed catalog entry errors do not echo upstream data', async () => {
  const token = 'secret-token-'.repeat(30);
  try {
    await fetchClaudeCodeModelsList(token, async () => Response.json({ data: [{ id: null, echo: token }] }));
    throw new Error('catalog fetch unexpectedly succeeded');
  } catch (error) {
    expect(error).toBeInstanceOf(TypeError);
    expect((error as Error).message).not.toContain(token.slice(0, 100));
  }
});

const SAMPLE_API_MODELS: ClaudeCodeApiModel[] = [
  { id: 'claude-opus-5-5', display_name: 'Claude Opus 5.5', max_input_tokens: 1_000_000 },
  { id: 'claude-sonnet-4-5-20250929', display_name: 'Claude Sonnet 4.5', max_input_tokens: 1_000_000 },
];

describe('chatFromCapabilities', () => {
  // Mirrors Opus 4.6: xhigh=false is dropped from the effort list.
  test('effort with low/medium/high/max + both thinking types → full reasoning', () => {
    const chat = chatFromCapabilities({
      effort: {
        supported: true,
        low: { supported: true },
        medium: { supported: true },
        high: { supported: true },
        xhigh: { supported: false },
        max: { supported: true },
      },
      thinking: { types: { enabled: { supported: true }, adaptive: { supported: true } } },
    });
    expect(chat).toEqual({
      reasoning: {
        effort: { supported: ['low', 'medium', 'high', 'max'], default: 'medium' },
        budget_tokens: { min: 1024 },
        adaptive: true,
      },
    });
  });

});

describe('buildClaudeCodeCatalog', () => {
  const models = buildClaudeCodeCatalog(SAMPLE_API_MODELS, new Set<FlagId>());

  test('preserves the original upstream id under upstreamData.upstreamModelId', () => {
    const byAlias = new Map(models.map(m => [m.id, m]));
    expect((byAlias.get('claude-opus-5-5')!.upstreamData as ClaudeCodeUpstreamData).upstreamModelId)
      .toBe('claude-opus-5-5');
    expect((byAlias.get('claude-sonnet-4-5')!.upstreamData as ClaudeCodeUpstreamData).upstreamModelId)
      .toBe('claude-sonnet-4-5-20250929');
  });

});
