import { expect, test } from 'vitest';

import { canonicalizeOpenAIResponsesPayload } from '@floway-dev/protocols/openai-responses';
import { assertEquals } from '@floway-dev/test-utils';

test('canonicalizes string and implicit-message wire inputs', () => {
  assertEquals(canonicalizeOpenAIResponsesPayload({ model: 'gpt-test', input: 'hello' }), {
    model: 'gpt-test',
    input: [{ type: 'message', role: 'user', content: 'hello' }],
  });

  assertEquals(canonicalizeOpenAIResponsesPayload({
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

test('rejects a payload without a usable model at the canonical boundary', () => {
  for (const payload of [
    { input: 'hello' },
    { model: '', input: 'hello' },
    { model: 42, input: 'hello' },
    { model: null, input: 'hello' },
  ]) {
    assertEquals(canonicalizeOpenAIResponsesPayload(payload), {
      error: {
        message: "Missing required parameter: 'model'.", param: 'model', code: 'missing_required_parameter',
      },
    });
  }
});

test('rejects a separate namespace on callable tool selectors', () => {
  for (const tool_choice of [
    { type: 'function', namespace: 'files', name: 'read' },
    { type: 'allowed_tools', mode: 'required', tools: [{ type: 'custom', namespace: 'files', name: 'edit' }] },
  ]) {
    expect(canonicalizeOpenAIResponsesPayload({ model: 'm', input: 'hi', tool_choice })).toEqual({
      error: {
        message: 'OpenAI Responses callable tool selectors, including allowed_tools entries, must use a qualified name, not a separate namespace field.',
        param: 'tool_choice',
      },
    });
  }
});

test('rejects output-only results on an input web_search_call', () => {
  expect(canonicalizeOpenAIResponsesPayload({
    model: 'm',
    input: [{ type: 'web_search_call', id: 'ws_1', status: 'completed', results: [] }],
  })).toEqual({
    error: {
      message: 'OpenAI Responses input web_search_call items must not include results.',
      param: 'input[0].results',
    },
  });
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
    assertEquals(canonicalizeOpenAIResponsesPayload({ model: 'gpt-test', input: [malformed] }), {
      error: {
        message: 'Untyped OpenAI Responses input items require a valid role and content.', param: 'input[0]',
      },
    });
  }
});

test('unexpected getters retain their original error and evaluation order', () => {
  const failure = new Error('unexpected getter failure', { cause: new Error('cause') });
  expect(() => canonicalizeOpenAIResponsesPayload({ get model() { throw failure; } })).toThrow(failure);
  expect(() => canonicalizeOpenAIResponsesPayload({ model: 'm', input: [null], get metadata() { throw failure; } })).toThrow(failure);
});
