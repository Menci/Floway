import { describe, expect, test } from 'vitest';

import {
  buildClaudeCodeCatalog,
  chatFromCapabilities,
  fetchClaudeCodeModelsList,
  type ClaudeCodeApiModel,
  type ClaudeCodeProviderData,
} from '../src/models.ts';
import { ProviderModelsUnavailableError, type FlagId } from '@floway-dev/provider';

test('catalog fetch exposes the upstream HTTP failure', async () => {
  try {
    await fetchClaudeCodeModelsList('at', async () => new Response('{"error":"denied"}', { status: 401, headers: { 'retry-after': '30' } }));
    throw new Error('catalog fetch unexpectedly succeeded');
  } catch (error) {
    expect(error).toBeInstanceOf(ProviderModelsUnavailableError);
    expect((error as ProviderModelsUnavailableError).displayResponse).toMatchObject({
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
    expect((error as Error).message).toBe('Claude Code /v1/models entry missing id');
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

  test('image_input=true + effort + both thinking types → full chat', () => {
    const chat = chatFromCapabilities({
      image_input: { supported: true },
      effort: {
        supported: true,
        low: { supported: true },
        medium: { supported: true },
        high: { supported: true },
      },
      thinking: { types: { enabled: { supported: true }, adaptive: { supported: true } } },
    });
    expect(chat).toEqual({
      modalities: { input: ['text', 'image'], output: ['text'] },
      reasoning: {
        effort: { supported: ['low', 'medium', 'high'], default: 'medium' },
        budget_tokens: { min: 1024 },
        adaptive: true,
      },
    });
  });

  test('effort default: first item when medium is not supported', () => {
    const chat = chatFromCapabilities({
      effort: {
        supported: true,
        low: { supported: true },
        high: { supported: true },
      },
      thinking: { types: { enabled: { supported: true } } },
    });
    expect(chat!.reasoning!.effort!.default).toBe('low');
  });
});

describe('buildClaudeCodeCatalog', () => {
  const models = buildClaudeCodeCatalog(SAMPLE_API_MODELS, new Set<FlagId>());

  test('preserves the original upstream id under providerData.upstreamModelId', () => {
    const byAlias = new Map(models.map(m => [m.id, m]));
    expect((byAlias.get('claude-opus-5-5')!.providerData as ClaudeCodeProviderData).upstreamModelId)
      .toBe('claude-opus-5-5');
    expect((byAlias.get('claude-sonnet-4-5')!.providerData as ClaudeCodeProviderData).upstreamModelId)
      .toBe('claude-sonnet-4-5-20250929');
  });

  test('keeps opaque blobs bound to the Claude Code upstream and upstream model id', () => {
    const byAlias = new Map(models.map(m => [m.id, m]));
    const sonnet = byAlias.get('claude-sonnet-4-5')!;
    expect(sonnet.upstreamModelId).toBe('claude-sonnet-4-5-20250929');
    expect(sonnet.opaqueBlobCompatibilityScope).toEqual({ bindToUpstream: true });
  });
});
