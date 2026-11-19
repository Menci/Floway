import { test } from 'vitest';

import { resolveCopilotRawModel } from '../src/model-selection.ts';
import type { CopilotModelsResponse, CopilotRawModel } from '../src/types.ts';
import { assertEquals } from '@floway-dev/test-utils';

const model = (
  id: string,
  options: {
    reasoningEfforts?: string[];
    contextWindow?: number;
  } = {},
): CopilotRawModel => ({
  id,
  name: id,
  version: id,
  supported_endpoints: ['/v1/messages'],
  capabilities: {
    type: 'chat',
    limits: {
      max_context_window_tokens: options.contextWindow ?? 200_000,
      max_prompt_tokens: options.contextWindow === 1_000_000 ? 936_000 : 168_000,
      max_output_tokens: options.contextWindow === 1_000_000 ? 64_000 : 32_000,
    },
    supports: {
      reasoning_effort: options.reasoningEfforts,
    },
  },
});

const models = (...data: CopilotRawModel[]): CopilotModelsResponse => ({
  object: 'list',
  data,
});

test('resolveCopilotRawModel strips Claude date aliases before variant selection', () => {
  const resolved = resolveCopilotRawModel(models(model('claude-haiku-4.5'), model('claude-haiku-4.5-1m', { contextWindow: 1_000_000 })), 'claude-haiku-4-5-20251001', { context1m: true });

  assertEquals(resolved?.id, 'claude-haiku-4.5-1m');
});

test('resolveCopilotRawModel keeps explicit suffix models as exact upstream ids', () => {
  const resolved = resolveCopilotRawModel(
    models(
      model('claude-opus-4.7'),
      model('claude-opus-4.7-xhigh', { reasoningEfforts: ['xhigh'] }),
      model('claude-opus-4.7-1m-internal', {
        contextWindow: 1_000_000,
        reasoningEfforts: ['low', 'medium', 'high', 'xhigh'],
      }),
    ),
    'claude-opus-4.7-xhigh',
    { context1m: true, reasoningEffort: 'medium' },
  );

  assertEquals(resolved?.id, 'claude-opus-4.7-xhigh');
});

test('resolveCopilotRawModel prefers 1m variants when they satisfy requested reasoning', () => {
  const resolved = resolveCopilotRawModel(
    models(
      model('claude-opus-4.7', { reasoningEfforts: ['medium'] }),
      model('claude-opus-4.7-high', { reasoningEfforts: ['high'] }),
      model('claude-opus-4.7-xhigh', { reasoningEfforts: ['xhigh'] }),
      model('claude-opus-4.7-1m-internal', {
        contextWindow: 1_000_000,
        reasoningEfforts: ['low', 'medium', 'high', 'xhigh'],
      }),
    ),
    'claude-opus-4-7',
    { reasoningEffort: 'xhigh' },
  );

  assertEquals(resolved?.id, 'claude-opus-4.7-1m-internal');
});

test('resolveCopilotRawModel prioritizes explicit 1m intent even when effort cannot be met', () => {
  const resolved = resolveCopilotRawModel(
    models(
      model('claude-opus-4.6', { reasoningEfforts: ['low', 'medium', 'high'] }),
      model('claude-opus-4.6-xhigh', { reasoningEfforts: ['xhigh'] }),
      model('claude-opus-4.6-1m', {
        contextWindow: 1_000_000,
        reasoningEfforts: ['low', 'medium', 'high'],
      }),
    ),
    'claude-opus-4-6',
    { context1m: true, reasoningEffort: 'xhigh' },
  );

  assertEquals(resolved?.id, 'claude-opus-4.6-1m');
});
