import { test } from 'vitest';

import { canonicalizeResponsesPayload } from '../src/canonicalize-responses-payload.ts';
import { TranslatorInputError } from '../src/translator-input-error.ts';
import type { ResponsesPayload } from '@floway-dev/protocols/responses';
import { assertEquals, assertThrows } from '@floway-dev/test-utils';

test('canonicalizes string and implicit-message wire inputs', () => {
  assertEquals(canonicalizeResponsesPayload({ model: 'gpt-test', input: 'hello' }), {
    model: 'gpt-test',
    input: [{ type: 'message', role: 'user', content: 'hello' }],
  });

  assertEquals(canonicalizeResponsesPayload({
    model: 'gpt-test',
    input: [
      { role: 'system', content: 'rules', phase: 'future_phase' },
      {
        role: 'user',
        content: [
          { type: 'input_text', text: 'look', prompt_cache_breakpoint: { mode: 'future_mode' } },
          { type: 'input_image', file_id: 'file_1', detail: 'original', prompt_cache_breakpoint: { mode: 'explicit' } },
          { type: 'input_file', file_id: 'file_2', prompt_cache_breakpoint: { mode: 'explicit' } },
        ],
      },
      { type: 'message', role: 'user', content: 'hello' },
      { type: 'function_call_output', call_id: 'call_1', output: 'result' },
    ],
  }), {
    model: 'gpt-test',
    input: [
      { type: 'message', role: 'system', content: 'rules', phase: 'future_phase' },
      {
        type: 'message',
        role: 'user',
        content: [
          { type: 'input_text', text: 'look', prompt_cache_breakpoint: { mode: 'future_mode' } },
          { type: 'input_image', file_id: 'file_1', detail: 'original', prompt_cache_breakpoint: { mode: 'explicit' } },
          { type: 'input_file', file_id: 'file_2', prompt_cache_breakpoint: { mode: 'explicit' } },
        ],
      },
      { type: 'message', role: 'user', content: 'hello' },
      { type: 'function_call_output', call_id: 'call_1', output: 'result' },
    ],
  });
});

test('canonicalizes an untyped message carrying an image without detail', () => {
  assertEquals(canonicalizeResponsesPayload({
    model: 'gpt-test',
    input: [{ role: 'user', content: [{ type: 'input_image', image_url: 'data:image/png;base64,AQID' }] }],
  }), {
    model: 'gpt-test',
    input: [{ type: 'message', role: 'user', content: [{ type: 'input_image', image_url: 'data:image/png;base64,AQID' }] }],
  });
});

test('rejects a payload without a usable model at the canonical boundary', () => {
  for (const payload of [
    { input: 'hello' },
    { model: '', input: 'hello' },
    { model: 42, input: 'hello' },
    { model: null, input: 'hello' },
  ]) {
    const error = assertThrows(
      () => canonicalizeResponsesPayload(payload),
      TranslatorInputError,
      "Missing required parameter: 'model'.",
    ) as TranslatorInputError;
    assertEquals(error.param, 'model');
    assertEquals(error.code, 'missing_required_parameter');
  }
});

test('rejects malformed untyped input items at the canonical boundary', () => {
  for (const malformed of [
    null,
    42,
    { content: 'missing role' },
    { role: 'unknown', content: 'invalid role' },
    { role: 'user', content: [null] },
    { role: 'user', content: [{}] },
    { role: 'user', content: [{ type: 'input_text' }] },
    { role: 'user', content: [{ type: 'input_text', text: 'invalid breakpoint', prompt_cache_breakpoint: {} }] },
    { role: 'user', content: 'invalid phase', phase: 42 },
  ]) {
    const error = assertThrows(
      () => canonicalizeResponsesPayload({
        model: 'gpt-test',
        input: [malformed] as unknown as ResponsesPayload['input'],
      }),
      TranslatorInputError,
      'valid role and content',
    ) as TranslatorInputError;
    assertEquals(error.param, 'input[0]');
  }
});

test('canonicalizeResponsesPayload preserves reasoning.context verbatim, including future modes', () => {
  const canonicalCurrent = canonicalizeResponsesPayload({
    model: 'gpt-test',
    input: [{ type: 'message', role: 'user', content: 'hi' }],
    reasoning: { effort: 'high', context: 'current_turn' },
  });
  assertEquals(canonicalCurrent.reasoning, { effort: 'high', context: 'current_turn' });

  // An unknown/future context string rides through the wire→canonical boundary
  // untouched — the upstream owns the accept/reject decision.
  const canonicalFuture = canonicalizeResponsesPayload({
    model: 'gpt-test',
    input: 'hi',
    reasoning: { context: 'future_mode' },
  });
  assertEquals(canonicalFuture.reasoning, { context: 'future_mode' });
});
