import { test } from 'vitest';

import { anthropicMessagesErrorWriter } from '../../../../src/protocols/anthropic-messages/as-source/error-body.ts';
import { buildPromptTooLongBody, PROMPT_TOO_LONG_MESSAGE } from '@floway-dev/protocols/anthropic-messages';
import { assert, assertEquals } from '@floway-dev/test-utils';

const decoded = (result: { body: Uint8Array } | undefined) => JSON.parse(new TextDecoder().decode(result!.body)) as {
  type: string;
  error: { type: string; message: string };
};

const upstreamOf = (status: number, body: unknown) => ({
  status,
  headers: new Headers({ 'x-upstream': 'a' }),
  body: new TextEncoder().encode(typeof body === 'string' ? body : JSON.stringify(body)),
});

test('buildPromptTooLongBody — Anthropic envelope with load-bearing prefix', () => {
  const body = new TextDecoder().decode(buildPromptTooLongBody());
  const parsed = JSON.parse(body) as { type: string; error: { type: string; message: string } };
  assertEquals(parsed.type, 'error');
  assertEquals(parsed.error.type, 'invalid_request_error');
  assertEquals(parsed.error.message, PROMPT_TOO_LONG_MESSAGE);
  assert(parsed.error.message.startsWith('prompt is too long:'));
});

test.each([
  ['Copilot Responses', { error: { code: 'model_max_prompt_tokens_exceeded', message: 'prompt token count of 1000000 exceeds the limit of 128000' } }],
  ['Codex Responses', { error: { code: 'context_length_exceeded', message: 'Your input exceeds the context window of this model. Please adjust your input and try again.' } }],
  ['message-only signal', { error: { message: "This model's maximum context length is 4097 tokens. However, your messages resulted in 4498 tokens." } }],
])('restates a context overflow from the %s as the prompt-too-long wording', (_name, body) => {
  const result = anthropicMessagesErrorWriter(upstreamOf(400, body));

  // Claude Code recognizes this exact wording and re-runs with a smaller
  // prompt; any other spelling of the same condition reads as an ordinary
  // failure and the client never retries.
  assertEquals(result!.status, 400);
  assertEquals(result!.headers.get('content-type'), 'application/json');
  const parsed = decoded(result);
  assertEquals(parsed.error.type, 'invalid_request_error');
  assert(parsed.error.message.startsWith('prompt is too long:'));
});

test('restates an unrelated failure in the Messages envelope rather than passing it through', () => {
  const result = anthropicMessagesErrorWriter(upstreamOf(401, { error: { code: 'invalid_api_key', message: 'bad token' } }));

  // The client speaks Messages, so it must not receive whatever envelope the
  // target protocol happened to use.
  assertEquals(result!.status, 500);
  assertEquals(decoded(result).error.message, 'bad token');
});

test('reads a non-JSON failure body as plain text', () => {
  const matching = anthropicMessagesErrorWriter(upstreamOf(502, 'some upstream prose: exceeds the context window of this model'));
  assert(decoded(matching).error.message.startsWith('prompt is too long:'));

  const unrelated = anthropicMessagesErrorWriter(upstreamOf(502, 'Bad Gateway'));
  assertEquals(decoded(unrelated).error.message, 'Bad Gateway');
});
