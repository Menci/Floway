import { test } from 'vitest';

import { restateAnthropicMessagesError } from '../../../../src/protocols/anthropic-messages/as-source/error-body.ts';
import { assert, assertEquals } from '@floway-dev/test-utils';

const decoded = (result: { body: unknown } | undefined) => result!.body as {
  type: string;
  error: { type: string; message: string };
};
const upstreamOf = (status: number, body: unknown, headers: Record<string, string> = {}) => [
  status,
  new Headers({ 'x-upstream': 'a', ...headers }),
  new TextEncoder().encode(typeof body === 'string' ? body : JSON.stringify(body)),
] as const;

test.each([
  ['Copilot Responses', { error: { code: 'model_max_prompt_tokens_exceeded', message: 'prompt token count of 1000000 exceeds the limit of 128000' } }],
  ['message-only signal', { error: { message: "This model's maximum context length is 4097 tokens. However, your messages resulted in 4498 tokens." } }],
])('restates a context overflow from the %s as the prompt-too-long wording', (_name, body) => {
  const result = restateAnthropicMessagesError(...upstreamOf(502, body));
  // Use our 400 invalid_request_error mapping and the prompt-too-long compatibility prefix.
  // Claude Code recognizes that substring without requiring this complete message or HTTP status.
  assertEquals(result!.status, 400);
  assertEquals(result!.headers.get('content-type'), 'application/json');
  const parsed = decoded(result);
  assertEquals(parsed.error.type, 'invalid_request_error');
  assert(parsed.error.message.startsWith('prompt is too long:'));
});
