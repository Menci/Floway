import { test } from 'vitest';

import { anthropicMessagesErrorWriter } from '../../../../src/protocols/anthropic-messages/as-source/error-body.ts';
import { buildPromptTooLongBody, PROMPT_TOO_LONG_MESSAGE } from '@floway-dev/protocols/anthropic-messages';
import { assert, assertEquals } from '@floway-dev/test-utils';

const decoded = (result: { body: Uint8Array } | undefined) => JSON.parse(new TextDecoder().decode(result!.body)) as {
  type: string;
  error: { type: string; message: string };
};

const upstreamOf = (status: number, body: unknown, headers: Record<string, string> = {}) => ({
  status,
  headers: new Headers({ 'x-upstream': 'a', ...headers }),
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
  const result = anthropicMessagesErrorWriter(upstreamOf(502, body));

  // Claude Code recognizes this exact wording and re-runs with a smaller
  // prompt; any other spelling of the same condition reads as an ordinary
  // failure and the client never retries. It also only retries on a 400, so
  // the overflow is the one failure whose status the restatement changes.
  assertEquals(result!.status, 400);
  assertEquals(result!.headers.get('content-type'), 'application/json');
  const parsed = decoded(result);
  assertEquals(parsed.error.type, 'invalid_request_error');
  assert(parsed.error.message.startsWith('prompt is too long:'));
});

test('restates a recognized failure in the Messages envelope and keeps the upstream status', () => {
  const result = anthropicMessagesErrorWriter(upstreamOf(401, { error: { code: 'invalid_api_key', message: 'bad token' } }));

  // The client speaks Messages, so it must not receive whatever envelope the
  // target protocol happened to use. The status is what actually happened, so
  // it travels unchanged rather than being re-derived from the message.
  assertEquals(result!.status, 401);
  assertEquals(decoded(result).error.message, 'bad token');
});

test('keeps the upstream headers a client reads', () => {
  const result = anthropicMessagesErrorWriter(upstreamOf(429, { error: { message: 'slow down' } }, { 'retry-after': '30', 'request-id': 'req_1' }));

  // A retry hint and a request id are as load-bearing as the body is.
  assertEquals(result!.headers.get('retry-after'), '30');
  assertEquals(result!.headers.get('request-id'), 'req_1');
  assertEquals(result!.headers.get('x-upstream'), 'a');
});

test('passes an unrecognized body through untouched', () => {
  // A failure the package cannot read as an error envelope is described more
  // faithfully by the upstream's own answer than by any envelope invented
  // here, so the trip states no replacement at all.
  assertEquals(anthropicMessagesErrorWriter(upstreamOf(502, 'Bad Gateway')), undefined);
  assertEquals(anthropicMessagesErrorWriter(upstreamOf(500, { detail: 'something broke' })), undefined);
  assertEquals(anthropicMessagesErrorWriter(upstreamOf(500, {})), undefined);
});

test('reads a message-only envelope the same way its stream does', () => {
  const result = anthropicMessagesErrorWriter(upstreamOf(529, { error: { message: 'Overloaded' } }));

  assertEquals(result!.status, 529);
  assertEquals(decoded(result).error.message, 'Overloaded');
});
