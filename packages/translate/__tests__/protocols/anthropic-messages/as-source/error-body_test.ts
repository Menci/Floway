import { test } from 'vitest';

import { restateAnthropicMessagesError } from '../../../../src/protocols/anthropic-messages/as-source/error-body.ts';
import { anthropicMessagesErrorFromIR } from '../../../../src/protocols/anthropic-messages/as-source/sse-to.ts';
import { errorPayloadFromWire } from '../../../../src/shared/api-error.ts';
import { buildPromptTooLongBody, PROMPT_TOO_LONG_MESSAGE } from '@floway-dev/protocols/anthropic-messages';
import { assert, assertEquals } from '@floway-dev/test-utils';

const decoded = (result: { body: unknown } | undefined) => result!.body as {
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
  const result = restateAnthropicMessagesError(upstreamOf(502, body));

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
  const result = restateAnthropicMessagesError(upstreamOf(401, { error: { code: 'invalid_api_key', message: 'bad token' } }));

  // The client speaks Messages, so it must not receive whatever envelope the
  // target protocol happened to use. The status is what actually happened, so
  // it travels unchanged rather than being re-derived from the message.
  assertEquals(result!.status, 401);
  assertEquals(decoded(result).error.message, 'bad token');
});

test('keeps the upstream headers a client reads', () => {
  const result = restateAnthropicMessagesError(upstreamOf(429, { error: { message: 'slow down' } }, { 'retry-after': '30', 'request-id': 'req_1' }));

  // A retry hint and a request id are as load-bearing as the body is.
  assertEquals(result!.headers.get('retry-after'), '30');
  assertEquals(result!.headers.get('request-id'), 'req_1');
  assertEquals(result!.headers.get('x-upstream'), 'a');
});

test('passes an unrecognized body through untouched', () => {
  // A failure the package cannot read as an error envelope is described more
  // faithfully by the upstream's own answer than by any envelope invented
  // here, so the trip states no replacement at all.
  assertEquals(restateAnthropicMessagesError(upstreamOf(502, 'Bad Gateway')), undefined);
  assertEquals(restateAnthropicMessagesError(upstreamOf(500, { detail: 'something broke' })), undefined);
  assertEquals(restateAnthropicMessagesError(upstreamOf(500, {})), undefined);
});

test('reads a message-only envelope the same way its stream does', () => {
  const result = restateAnthropicMessagesError(upstreamOf(529, { error: { message: 'Overloaded' } }));

  assertEquals(result!.status, 529);
  assertEquals(decoded(result).error.message, 'Overloaded');
});

test('carries the fields the target protocol states that the IR does not name', () => {
  // A target protocol may report failure data no other protocol has. The
  // restated envelope keeps it instead of describing the failure less
  // completely than the upstream did.
  const result = restateAnthropicMessagesError(upstreamOf(400, {
    error: { message: 'bad request', code: 'invalid', safety_violations: [{ category: 'hate' }], headers: { 'x-trace': 'abc' } },
  }));

  const error = decoded(result).error as Record<string, unknown>;
  assertEquals(error.provider_specific_fields, {
    code: 'invalid',
    safety_violations: [{ category: 'hate' }],
    headers: { 'x-trace': 'abc' },
  });
});

test('merges loose error fields with the upstream container and keeps its collision priority', () => {
  const result = restateAnthropicMessagesError(upstreamOf(400, {
    error: { message: 'bad request', provider_specific_fields: { stack: 'theirs' }, stack: 'legacy', retry_after: 10, code: 'invalid_value', param: 'temperature' },
  }));

  assertEquals((decoded(result).error as Record<string, unknown>).provider_specific_fields, {
    stack: 'theirs', retry_after: 10, code: 'invalid_value', param: 'temperature',
  });
});

test('preserves the same failure fields before and during a stream', () => {
  const error = {
    message: 'bad field', type: 'invalid_request_error', code: 'invalid_value', param: 'temperature',
    provider_specific_fields: { request_id: 'req_1' }, retry_after: 10,
  };
  const result = restateAnthropicMessagesError(upstreamOf(400, { error }));
  const expected = {
    type: 'invalid_request_error', message: 'bad field',
    provider_specific_fields: { code: 'invalid_value', param: 'temperature', request_id: 'req_1', retry_after: 10 },
  };
  assertEquals(decoded(result).error, expected);
  assertEquals(anthropicMessagesErrorFromIR(errorPayloadFromWire(error)), expected);
});
