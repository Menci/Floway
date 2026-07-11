import { test } from 'vitest';

import {
  buildPromptTooLongBody,
  isContextExceededError,
  isContextExceededErrorObject,
  isContextExceededErrorText,
  PROMPT_TOO_LONG_MESSAGE,
  rewriteContextExceededToPromptTooLong,
} from './context-window-error.ts';
import { assert, assertEquals, assertFalse } from '../../test-assert.ts';

test('isContextExceededError — recognizes canonical code strings', () => {
  assert(isContextExceededError({ code: 'context_length_exceeded' }));
  assert(isContextExceededError({ code: 'model_max_prompt_tokens_exceeded' }));
  assertFalse(isContextExceededError({ code: 'rate_limit_exceeded' }));
  assertFalse(isContextExceededError(undefined));
  assertFalse(isContextExceededError(null));
});

test('isContextExceededError — recognizes fallback message substrings', () => {
  assert(isContextExceededError({ message: 'Your input exceeds the context window of this model. Please adjust your input.' }));
  assert(isContextExceededError({ message: "This model's maximum context length is 4097 tokens." }));
  assert(isContextExceededError({ message: 'Request body is too large for model context window' }));
  assertFalse(isContextExceededError({ message: 'a network hiccup' }));
});

test('isContextExceededErrorObject — walks the outer envelope', () => {
  assert(isContextExceededErrorObject({ error: { code: 'context_length_exceeded', message: 'x' } }));
  assert(isContextExceededErrorObject({ error: { code: 'model_max_prompt_tokens_exceeded', message: 'x' } }));
  assertFalse(isContextExceededErrorObject({ error: { code: 'server_error', message: 'x' } }));
  assertFalse(isContextExceededErrorObject({ nope: true }));
});

test('isContextExceededErrorText — parses JSON when it can, falls back to plain-text substring', () => {
  assert(isContextExceededErrorText(JSON.stringify({ error: { code: 'context_length_exceeded' } })));
  assert(isContextExceededErrorText('some non-json prefix: exceeds the context window of this model'));
  assertFalse(isContextExceededErrorText('unrelated 502 body'));
});

test('buildPromptTooLongBody — Anthropic envelope with load-bearing prefix', () => {
  const body = new TextDecoder().decode(buildPromptTooLongBody());
  const parsed = JSON.parse(body) as { type: string; error: { type: string; message: string } };
  assertEquals(parsed.type, 'error');
  assertEquals(parsed.error.type, 'invalid_request_error');
  assertEquals(parsed.error.message, PROMPT_TOO_LONG_MESSAGE);
  assert(parsed.error.message.startsWith('prompt is too long:'));
});

test('rewriteContextExceededToPromptTooLong — rewrites Copilot Responses shape', () => {
  const upstream = {
    status: 400,
    headers: new Headers({ 'x-copilot-request-id': 'abc' }),
    body: new TextEncoder().encode(JSON.stringify({
      error: { code: 'model_max_prompt_tokens_exceeded', message: 'prompt token count of 1000000 exceeds the limit of 128000' },
    })),
  };

  const result = rewriteContextExceededToPromptTooLong(upstream);
  assert(result !== undefined);
  assertEquals(result!.status, 400);
  assertEquals(result!.headers.get('content-type'), 'application/json');
  const parsed = JSON.parse(new TextDecoder().decode(result!.body)) as { error: { message: string } };
  assert(parsed.error.message.startsWith('prompt is too long:'));
});

test('rewriteContextExceededToPromptTooLong — rewrites Codex Responses shape', () => {
  const upstream = {
    status: 400,
    headers: new Headers(),
    body: new TextEncoder().encode(JSON.stringify({
      error: { code: 'context_length_exceeded', message: 'Your input exceeds the context window of this model. Please adjust your input and try again.' },
    })),
  };
  const result = rewriteContextExceededToPromptTooLong(upstream);
  assert(result !== undefined);
});

test('rewriteContextExceededToPromptTooLong — passes unrelated bodies through unchanged', () => {
  const upstream = {
    status: 401,
    headers: new Headers(),
    body: new TextEncoder().encode(JSON.stringify({ error: { code: 'invalid_api_key', message: 'bad token' } })),
  };
  assertEquals(rewriteContextExceededToPromptTooLong(upstream), undefined);
});

test('rewriteContextExceededToPromptTooLong — passes non-json bodies through unchanged', () => {
  const upstream = {
    status: 502,
    headers: new Headers(),
    body: new TextEncoder().encode('Bad Gateway'),
  };
  assertEquals(rewriteContextExceededToPromptTooLong(upstream), undefined);
});
