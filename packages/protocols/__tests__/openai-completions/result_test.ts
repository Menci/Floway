import { expect, test } from 'vitest';

import { decodeOpenAICompletionsResult } from '../../src/openai-completions/index.ts';

const result = {
  id: 'cmpl-1',
  object: 'text_completion',
  created: 1,
  model: 'm',
  choices: [{ index: 0, text: 'answer', finish_reason: 'provider_stop', vendor_choice: { sample: 1 } }],
  usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5, prompt_tokens_details: { cached_tokens: 1 }, vendor_usage: true },
  vendor_result: 'forwarded',
};

test('decodes typed completions and keeps the original wire fields', () => {
  const decoded = decodeOpenAICompletionsResult(result);
  expect(decoded).toEqual({ ok: true, value: result });
  if (!decoded.ok) throw decoded.error;
  expect(decoded.value).toBe(result);
});

test.each([
  ['object', { object: 'chat.completion' }],
  ['time', { created: Infinity }],
  ['choices', { choices: [{ index: 0, finish_reason: null }] }],
  ['choice index', { choices: [{ index: 0.5, text: '', finish_reason: null }] }],
  ['finish reason', { choices: [{ index: 0, text: '', finish_reason: 3 }] }],
  ['usage', { usage: { prompt_tokens: 2, completion_tokens: '3', total_tokens: 5 } }],
  ['usage details', { usage: { ...result.usage, prompt_tokens_details: { cached_tokens: -1 } } }],
  ['fingerprint', { system_fingerprint: [] }],
])('rejects malformed completions %s', (_field, patch) => {
  expect(decodeOpenAICompletionsResult({ ...result, ...patch })).toMatchObject({ ok: false, error: expect.any(Error) });
});
