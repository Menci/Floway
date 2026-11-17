import { test, vi } from 'vitest';

import { buildCustomToolInputSchema, unwrapCustomToolInput } from '../../src/shared/custom-tool.ts';
import { assertEquals } from '@floway-dev/test-utils';

test('buildCustomToolInputSchema returns plain single-string schema when format.definition is empty', () => {
  assertEquals(buildCustomToolInputSchema({ type: 'grammar', syntax: 'lark', definition: '' }), {
    type: 'object',
    additionalProperties: false,
    required: ['input'],
    properties: { input: { type: 'string' } },
  });
});

test('buildCustomToolInputSchema preserves regex syntax in the description', () => {
  assertEquals(buildCustomToolInputSchema({ type: 'grammar', syntax: 'regex', definition: '[a-z]+' }), {
    type: 'object',
    additionalProperties: false,
    required: ['input'],
    properties: { input: { type: 'string', description: 'Regex: [a-z]+' } },
  });
});

test('buildCustomToolInputSchema preserves an open-string syntax label', () => {
  assertEquals(buildCustomToolInputSchema({ type: 'grammar', syntax: 'peg', definition: 'start <- value' }), {
    type: 'object',
    additionalProperties: false,
    required: ['input'],
    properties: { input: { type: 'string', description: 'Grammar (peg): start <- value' } },
  });
});

test('unwrapCustomToolInput extracts the input field from a valid wrapped JSON blob', () => {
  assertEquals(unwrapCustomToolInput('{"input":"hello world"}'), 'hello world');
});

test('unwrapCustomToolInput falls back to the raw blob when JSON parse fails', () => {
  assertEquals(unwrapCustomToolInput('not json'), 'not json');
  assertEquals(unwrapCustomToolInput('{"input":"unterminated'), '{"input":"unterminated');
});

test('unwrapCustomToolInput falls back to the raw blob when input field is missing', () => {
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    assertEquals(unwrapCustomToolInput('{"other":"value"}'), '{"other":"value"}');
    assertEquals(warning.mock.calls, [['Custom tool wrapper has no string input; returning the entire JSON value as freeform input.']]);
  } finally {
    warning.mockRestore();
  }
});
