import { test } from 'vitest';

import { restateAnthropicMessagesError } from '../../../../src/protocols/anthropic-messages/as-source/error-body.ts';
import { anthropicMessagesErrorFromIR } from '../../../../src/protocols/anthropic-messages/as-source/error.ts';
import { errorPayloadFromWire } from '../../../../src/shared/api-error.ts';
import { buildPromptTooLongBody, PROMPT_TOO_LONG_MESSAGE } from '@floway-dev/protocols/anthropic-messages';
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
  const result = restateAnthropicMessagesError(...upstreamOf(502, body));
  assertEquals(result!.status, 400);
  assertEquals(result!.headers.get('content-type'), 'application/json');
  const parsed = decoded(result);
  assertEquals(parsed.error.type, 'invalid_request_error');
  assert(parsed.error.message.startsWith('prompt is too long:'));
});

test('restates a recognized failure in the Messages envelope and keeps the upstream status', () => {
  const result = restateAnthropicMessagesError(...upstreamOf(401, { error: { code: 'invalid_api_key', message: 'bad token' } }));
  assertEquals(result!.status, 401);
  assertEquals(decoded(result).error.message, 'bad token');
});

test('keeps the upstream headers a client reads', () => {
  const result = restateAnthropicMessagesError(...upstreamOf(429, { error: { message: 'slow down' } }, { 'retry-after': '30', 'request-id': 'req_1' }));
  assertEquals(result!.headers.get('retry-after'), '30');
  assertEquals(result!.headers.get('request-id'), 'req_1');
  assertEquals(result!.headers.get('x-upstream'), 'a');
});

test('passes an unrecognized body through untouched', () => {
  assertEquals(restateAnthropicMessagesError(...upstreamOf(502, 'Bad Gateway')), undefined);
  assertEquals(restateAnthropicMessagesError(...upstreamOf(502, 'exceeds the context window of this model')), undefined);
  assertEquals(restateAnthropicMessagesError(...upstreamOf(500, { detail: 'something broke' })), undefined);
  assertEquals(restateAnthropicMessagesError(...upstreamOf(500, {})), undefined);
});

test('reads a message-only envelope the same way its stream does', () => {
  const result = restateAnthropicMessagesError(...upstreamOf(529, { error: { message: 'Overloaded' } }));

  assertEquals(result!.status, 529);
  assertEquals(decoded(result).error.message, 'Overloaded');
});

test('carries the fields the target protocol states that the IR does not name', () => {
  const result = restateAnthropicMessagesError(...upstreamOf(400, {
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
  const result = restateAnthropicMessagesError(...upstreamOf(400, {
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
  const result = restateAnthropicMessagesError(...upstreamOf(400, { error }));
  const expected = {
    type: 'invalid_request_error', message: 'bad field',
    provider_specific_fields: { code: 'invalid_value', param: 'temperature', request_id: 'req_1', retry_after: 10 },
  };
  assertEquals(decoded(result).error, expected);
  assertEquals(anthropicMessagesErrorFromIR(errorPayloadFromWire(error)), expected);
});

test('normalizes a wire msg alias before treating the object as an IR error', () => {
  const details = { request_id: 'req_alias' };
  const wire = { msg: 'Alias message', code: 'invalid_value', param: 'temperature', provider_specific_fields: details };
  const error = errorPayloadFromWire({ error: wire });
  assertEquals(error.message, wire.msg);
  assertEquals(error.code, wire.code);
  assertEquals(error.param, wire.param);
  assert(error.provider_specific_fields === details);
  assertEquals(anthropicMessagesErrorFromIR(error).message, wire.msg);
  const beforeStream = restateAnthropicMessagesError(...upstreamOf(400, { error: wire }));
  assertEquals(decoded(beforeStream).error, anthropicMessagesErrorFromIR(error));
});

test('a canonical wire error keeps its original object', () => {
  const wire = { message: 'Canonical message', code: 'invalid_value' };
  assert(errorPayloadFromWire({ error: wire }) === wire);
});
