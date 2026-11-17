import { test } from 'vitest';

import { copilotModelSupportsFastVariant, resolveCopilotRawModel } from '../src/model-selection.ts';
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

test('resolveCopilotRawModel falls back to the base when fast hint is set but no -fast variant exists', () => {
  // Selection stays best-effort; the entry point validates the hard contract.
  const resolved = resolveCopilotRawModel(
    models(model('claude-opus-4.7'), model('claude-opus-4.7-xhigh', { reasoningEfforts: ['xhigh'] })),
    'claude-opus-4-7',
    { fast: true },
  );

  assertEquals(resolved?.id, 'claude-opus-4.7');
});

test('copilotModelSupportsFastVariant is true iff any raw variant has the -fast suffix', () => {
  assertEquals(copilotModelSupportsFastVariant([model('claude-opus-4.6'), model('claude-opus-4.6-fast')]), true);
  assertEquals(copilotModelSupportsFastVariant([model('claude-opus-4.7'), model('claude-opus-4.7-xhigh', { reasoningEfforts: ['xhigh'] })]), false);
  assertEquals(copilotModelSupportsFastVariant([]), false);
});

test('resolveCopilotRawModel leaves a -fast id that has no base sibling alone', () => {
  // `grok-code-fast` is its own model: there is no `grok-code` for it to be a
  // lane of, so the suffix is part of the name and the id resolves to itself
  // whatever the hints say.
  const catalog = models(model('grok-code-fast'));

  assertEquals(resolveCopilotRawModel(catalog, 'grok-code-fast', {})?.id, 'grok-code-fast');
  assertEquals(resolveCopilotRawModel(catalog, 'grok-code-fast', { fast: true })?.id, 'grok-code-fast');
});
