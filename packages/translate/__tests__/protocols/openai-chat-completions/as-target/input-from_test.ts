import { test } from 'vitest';

import type { IRInputSettings } from '../../../../src/ir/input/types.ts';
import { openaiChatCompletionsSettingsFromIR } from '../../../../src/protocols/openai-chat-completions/as-target/input-from.ts';
import { assertEquals } from '@floway-dev/test-utils';

// OpenAI deprecated `max_tokens` in favor of `max_completion_tokens`, and
// compatible upstreams reject a request that carries both. The projection must
// therefore produce exactly one field, and it must be the modern one.
test.each([
  { limits: {}, expected: {} },
  { limits: { max_output_tokens: 128000 }, expected: { max_completion_tokens: 128000 } },
  { limits: { max_output_tokens: 0 }, expected: { max_completion_tokens: 0 } },
  { limits: { max_output_tokens: null }, expected: { max_completion_tokens: null } },
  { limits: { max_visible_output_tokens: 32 }, expected: { max_completion_tokens: 32 } },
  { limits: { max_visible_output_tokens: 0 }, expected: { max_completion_tokens: 0 } },
  { limits: { max_visible_output_tokens: null }, expected: { max_completion_tokens: null } },
  { limits: { max_visible_output_tokens: 32, max_output_tokens: 64 }, expected: { max_completion_tokens: 64 } },
  { limits: { max_visible_output_tokens: 32, max_output_tokens: 0 }, expected: { max_completion_tokens: 0 } },
  { limits: { max_visible_output_tokens: 32, max_output_tokens: null }, expected: { max_completion_tokens: null } },
])('Chat Completions projects $limits onto the modern output cap alone', ({ limits, expected }) => {
  const settings: IRInputSettings = { model: 'm', stream: true, ...limits };
  const result = openaiChatCompletionsSettingsFromIR(settings);
  assertEquals(result, expected);
  assertEquals('max_tokens' in result, false);
  assertEquals(settings, { model: 'm', stream: true, ...limits });
});
