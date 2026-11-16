import { expect, test } from 'vitest';

import type { IRInputSettings } from '../../../../src/ir/input/types.ts';
import { openaiChatCompletionsSettingsFromIR } from '../../../../src/protocols/openai-chat-completions/as-target/input-from.ts';

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
])('Floway projects token limits $limits to exactly one canonical field', ({ limits, expected }) => {
  const settings: IRInputSettings = { model: 'm', stream: true, ...limits };
  const result = openaiChatCompletionsSettingsFromIR(settings);
  expect(result).toEqual(expected);
  expect(result).not.toHaveProperty('max_tokens');
  expect(settings).toEqual({ model: 'm', stream: true, ...limits });
});
