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
