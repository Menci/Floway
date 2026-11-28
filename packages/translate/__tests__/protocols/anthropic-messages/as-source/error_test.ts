import { test } from 'vitest';

import type { IRErrorPayload } from '../../../../src/ir/output/error.ts';
import { anthropicMessagesErrorEnvelope } from '../../../../src/protocols/anthropic-messages/as-source/error.ts';
import { assert, assertEquals } from '@floway-dev/test-utils';

const decoded = (result: { body: unknown }) => result.body as {
  type: string;
  error: { type: string; message: string };
};

test.each<[string, IRErrorPayload]>([
  ['Copilot Responses', { code: 'model_max_prompt_tokens_exceeded', message: 'prompt token count of 1000000 exceeds the limit of 128000' }],
  ['message-only signal', { message: "This model's maximum context length is 4097 tokens. However, your messages resulted in 4498 tokens." }],
  ['Google AI Studio Gemini', { type: 'invalid_request_error', message: 'The input token count (1196265) exceeds the maximum number of tokens allowed (1048575).', provider_specific_fields: { code: 400, status: 'INVALID_ARGUMENT' } }],
])('restates a context overflow from the %s as the prompt-too-long wording', (_name, payload) => {
  const result = anthropicMessagesErrorEnvelope(payload);
  // Use our 400 invalid_request_error mapping and the prompt-too-long compatibility prefix.
  // Claude Code recognizes that substring without requiring this complete message or HTTP status.
  assertEquals(result.status, 400);
  const parsed = decoded(result);
  assertEquals(parsed.error.type, 'invalid_request_error');
  assert(parsed.error.message.startsWith('prompt is too long:'));
});
