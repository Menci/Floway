import { test } from 'vitest';

import { mergeCopilotVariants } from '../src/merge-variants.ts';
import { copilotVariantIndex } from '../src/model-variants.ts';
import type { CopilotRawModel } from '../src/types.ts';
import { assertEquals } from '@floway-dev/test-utils';

const assertSameSet = <T>(actual: readonly T[] | undefined, expected: T[]) => {
  // Union order follows the input variant order, which is an implementation
  // detail of upstream /models. Assert membership only so the tests do not
  // flake when upstream reorders.
  assertEquals(new Set(actual), new Set(expected));
  assertEquals(actual?.length, expected.length);
};

const claudeVariant = (
  id: string,
  overrides: {
    maxContextWindowTokens?: number;
    maxPromptTokens?: number;
    maxOutputTokens?: number;
    reasoningEfforts?: string[];
  } = {},
): CopilotRawModel => ({
  id,
  name: id,
  version: id,
  display_name: id,
  capabilities: {
    type: 'chat',
    limits: {
      ...(overrides.maxContextWindowTokens !== undefined ? { max_context_window_tokens: overrides.maxContextWindowTokens } : {}),
      ...(overrides.maxPromptTokens !== undefined ? { max_prompt_tokens: overrides.maxPromptTokens } : {}),
      ...(overrides.maxOutputTokens !== undefined ? { max_output_tokens: overrides.maxOutputTokens } : {}),
    },
    supports: {
      ...(overrides.reasoningEfforts !== undefined ? { reasoning_effort: overrides.reasoningEfforts } : {}),
    },
  },
  supported_endpoints: ['/v1/messages', '/chat/completions'],
});

test('mergeCopilotVariants merges 4.7 base + high + xhigh + 1m-internal', () => {
  const input: CopilotRawModel[] = [
    claudeVariant('claude-opus-4.7-1m-internal', {
      maxContextWindowTokens: 1_000_000,
      maxPromptTokens: 936_000,
      maxOutputTokens: 64_000,
      reasoningEfforts: ['low', 'medium', 'high', 'xhigh'],
    }),
    claudeVariant('claude-opus-4.7-high', {
      maxContextWindowTokens: 200_000,
      maxPromptTokens: 168_000,
      maxOutputTokens: 32_000,
      reasoningEfforts: ['high'],
    }),
    claudeVariant('claude-opus-4.7-xhigh', {
      maxContextWindowTokens: 200_000,
      maxPromptTokens: 168_000,
      maxOutputTokens: 32_000,
      reasoningEfforts: ['xhigh'],
    }),
    {
      ...claudeVariant('claude-opus-4.7', {
        maxContextWindowTokens: 200_000,
        maxPromptTokens: 168_000,
        maxOutputTokens: 32_000,
        reasoningEfforts: ['medium'],
      }),
      name: 'Claude Opus 4.7',
      display_name: 'Claude Opus 4.7',
    },
  ];

  const merged = mergeCopilotVariants(copilotVariantIndex(input));
  assertEquals(merged.length, 1);
  const m = merged[0];
  const capabilities = m.capabilities!;

  assertEquals(m.id, 'claude-opus-4-7');
  assertEquals(m.name, 'Claude Opus 4.7');
  assertEquals(m.version, 'claude-opus-4-7');
  assertEquals(m.display_name, 'Claude Opus 4.7');
  assertEquals(capabilities.limits?.max_context_window_tokens, 1_000_000);
  assertEquals(capabilities.limits?.max_prompt_tokens, 936_000);
  assertEquals(capabilities.limits?.max_output_tokens, 64_000);
  assertSameSet(capabilities.supports?.reasoning_effort, ['low', 'medium', 'high', 'xhigh']);
});

test('mergeCopilotVariants merges 4.6 base + 1m', () => {
  const input: CopilotRawModel[] = [
    claudeVariant('claude-opus-4.6-1m', {
      maxContextWindowTokens: 1_000_000,
      maxPromptTokens: 936_000,
      maxOutputTokens: 64_000,
    }),
    claudeVariant('claude-opus-4.6', {
      maxContextWindowTokens: 200_000,
      maxPromptTokens: 168_000,
      maxOutputTokens: 32_000,
    }),
  ];

  const merged = mergeCopilotVariants(copilotVariantIndex(input));
  assertEquals(merged.length, 1);
  const m = merged[0];
  const capabilities = m.capabilities!;

  assertEquals(m.id, 'claude-opus-4-6');
  assertEquals(capabilities.limits?.max_context_window_tokens, 1_000_000);
  assertEquals(capabilities.limits?.max_prompt_tokens, 936_000);
  assertEquals(capabilities.limits?.max_output_tokens, 64_000);
});

test('mergeCopilotVariants merges 4.6 base + 1m + fast', () => {
  const input: CopilotRawModel[] = [
    claudeVariant('claude-opus-4.6-1m', {
      maxContextWindowTokens: 1_000_000,
      maxPromptTokens: 936_000,
      maxOutputTokens: 64_000,
    }),
    claudeVariant('claude-opus-4.6-fast', {
      maxContextWindowTokens: 200_000,
      maxPromptTokens: 168_000,
      maxOutputTokens: 16_000,
    }),
    claudeVariant('claude-opus-4.6', {
      maxContextWindowTokens: 200_000,
      maxPromptTokens: 168_000,
      maxOutputTokens: 32_000,
    }),
  ];

  const merged = mergeCopilotVariants(copilotVariantIndex(input));
  assertEquals(merged.length, 1);
  const m = merged[0];

  // The merged surface shows one public id; -fast collapses into it the
  // same way -1m does. Per-tier behavior is resolved at request time via
  // model-selection + the speed: 'fast' field, not exposed in the catalog.
  assertEquals(m.id, 'claude-opus-4-6');
  assertEquals(m.capabilities?.limits?.max_context_window_tokens, 1_000_000);
});

test('mergeCopilotVariants leaves non-Claude models untouched', () => {
  const input: CopilotRawModel[] = [claudeVariant('gpt-5.4', { maxContextWindowTokens: 272_000 }), claudeVariant('gemini-2.5-pro', { maxContextWindowTokens: 1_000_000 })];

  const merged = mergeCopilotVariants(copilotVariantIndex(input));
  assertEquals(
    merged.map(m => m.id),
    ['gpt-5.4', 'gemini-2.5-pro'],
  );
  assertEquals(merged[0].capabilities?.limits?.max_context_window_tokens, 272_000);
});

test('mergeCopilotVariants preserves order across mixed claude/non-claude models', () => {
  const input: CopilotRawModel[] = [claudeVariant('claude-opus-4.7-1m-internal'), claudeVariant('gpt-5.5'), claudeVariant('claude-opus-4.7'), claudeVariant('claude-sonnet-4.6')];

  const merged = mergeCopilotVariants(copilotVariantIndex(input));
  assertEquals(
    merged.map(m => m.id),
    ['claude-opus-4-7', 'gpt-5.5', 'claude-sonnet-4-6'],
  );
});

test('mergeCopilotVariants preserves vision/adaptive_thinking/budget from base variant', () => {
  // These fields are uniform per family (every variant shares the same base
  // capability), so the merge just keeps the base's value via the ...supports spread.
  const input: CopilotRawModel[] = [
    {
      ...claudeVariant('claude-opus-4.7', { reasoningEfforts: ['medium'] }),
      capabilities: {
        type: 'chat',
        limits: { max_context_window_tokens: 200_000 },
        supports: {
          vision: true,
          reasoning_effort: ['medium'],
          min_thinking_budget: 1024,
          max_thinking_budget: 32768,
          adaptive_thinking: true,
        },
      },
    },
    {
      ...claudeVariant('claude-opus-4.7-xhigh', { reasoningEfforts: ['xhigh'] }),
      capabilities: {
        type: 'chat',
        limits: { max_context_window_tokens: 200_000 },
        supports: { vision: true, reasoning_effort: ['xhigh'] },
      },
    },
  ];

  const merged = mergeCopilotVariants(copilotVariantIndex(input));
  assertEquals(merged.length, 1);
  const supports = merged[0].capabilities?.supports;
  // vision and budget fields come from the base via spread
  assertEquals(supports?.vision, true);
  assertEquals(supports?.min_thinking_budget, 1024);
  assertEquals(supports?.max_thinking_budget, 32768);
  assertEquals(supports?.adaptive_thinking, true);
  // reasoning_effort is the union
  assertSameSet(supports?.reasoning_effort, ['medium', 'xhigh']);
});

test('mergeCopilotVariants merges a non-Claude base with its -fast lane', () => {
  const input: CopilotRawModel[] = [
    claudeVariant('gpt-5.6-sol', { maxContextWindowTokens: 1_050_000, reasoningEfforts: ['low', 'medium', 'high'] }),
    claudeVariant('gpt-5.6-sol-fast', { maxContextWindowTokens: 1_050_000, reasoningEfforts: ['low', 'medium', 'high'] }),
  ];

  const merged = mergeCopilotVariants(copilotVariantIndex(input));
  assertEquals(
    merged.map(m => m.id),
    ['gpt-5.6-sol'],
  );
});

test('mergeCopilotVariants keeps a -fast id whose base does not exist', () => {
  // `grok-code-fast` names a model, not the lane of a `grok-code` that the
  // catalog has never published.
  const input: CopilotRawModel[] = [claudeVariant('grok-code-fast'), claudeVariant('gpt-5.6-sol'), claudeVariant('gpt-5.6-sol-fast')];

  const merged = mergeCopilotVariants(copilotVariantIndex(input));
  assertEquals(
    merged.map(m => m.id),
    ['grok-code-fast', 'gpt-5.6-sol'],
  );
});
