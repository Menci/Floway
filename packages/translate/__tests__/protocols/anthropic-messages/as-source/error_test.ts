import { test } from 'vitest';

import { writeAnthropicMessagesError } from '../../../../src/protocols/anthropic-messages/as-source/error.ts';
import { irErrorPayloadFromBody } from '../../../../src/shared/api-error.ts';
import { assert, assertEquals } from '@floway-dev/test-utils';

const decoded = (result: { body: unknown }) => result.body as {
  type: string;
  error: { type: string; message: string };
};

test.each([
  ['Copilot Responses', { error: { code: 'model_max_prompt_tokens_exceeded', message: 'prompt token count of 1000000 exceeds the limit of 128000' } }],
  ['message-only signal', { error: { message: "This model's maximum context length is 4097 tokens. However, your messages resulted in 4498 tokens." } }],
])('restates a context overflow from the %s as the prompt-too-long wording', (_name, body) => {
  const payload = irErrorPayloadFromBody(new TextEncoder().encode(JSON.stringify(body)));
  if (payload === undefined) throw new Error('Expected parsed IR error payload');
  const result = writeAnthropicMessagesError(502, new Headers({ 'x-upstream': 'a' }), payload);
  // Use our 400 invalid_request_error mapping and the prompt-too-long compatibility prefix.
  // Claude Code recognizes that substring without requiring this complete message or HTTP status.
  assertEquals(result.status, 400);
  assertEquals(result.headers.get('content-type'), 'application/json');
  const parsed = decoded(result);
  assertEquals(parsed.error.type, 'invalid_request_error');
  assert(parsed.error.message.startsWith('prompt is too long:'));
});
