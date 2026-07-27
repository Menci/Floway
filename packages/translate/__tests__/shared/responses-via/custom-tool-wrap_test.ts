import { test } from 'vitest';

import { buildCustomToolInputSchema, unwrapCustomToolInput } from '../../../src/shared/responses-via/custom-tool-wrap.ts';
import { assertEquals } from '@floway-dev/test-utils';

// ── buildCustomToolInputSchema ──

test('buildCustomToolInputSchema returns plain single-string schema when format is absent', () => {
  assertEquals(buildCustomToolInputSchema(), {
    type: 'object',
    additionalProperties: false,
    required: ['input'],
    properties: { input: { type: 'string' } },
  });
});

test('buildCustomToolInputSchema returns plain single-string schema when format has no definition', () => {
  assertEquals(buildCustomToolInputSchema({ type: 'grammar', syntax: 'lark' }), {
    type: 'object',
    additionalProperties: false,
    required: ['input'],
    properties: { input: { type: 'string' } },
  });
});

test('buildCustomToolInputSchema returns plain single-string schema when format.definition is empty', () => {
  assertEquals(buildCustomToolInputSchema({ definition: '' }), {
    type: 'object',
    additionalProperties: false,
    required: ['input'],
    properties: { input: { type: 'string' } },
  });
});

test('buildCustomToolInputSchema injects Lark grammar description when format.definition is non-empty', () => {
  assertEquals(buildCustomToolInputSchema({ type: 'grammar', syntax: 'lark', definition: 'start: "ok"' }), {
    type: 'object',
    additionalProperties: false,
    required: ['input'],
    properties: { input: { type: 'string', description: 'Lark grammar: start: "ok"' } },
  });
});

test('buildCustomToolInputSchema ignores non-string definition values', () => {
  assertEquals(buildCustomToolInputSchema({ definition: 42 as unknown as string }), {
    type: 'object',
    additionalProperties: false,
    required: ['input'],
    properties: { input: { type: 'string' } },
  });
});

// ── unwrapCustomToolInput ──

test('unwrapCustomToolInput returns empty string for empty input', () => {
  assertEquals(unwrapCustomToolInput(''), '');
});

test('unwrapCustomToolInput extracts the input field from a valid wrapped JSON blob', () => {
  assertEquals(unwrapCustomToolInput('{"input":"hello world"}'), 'hello world');
});

test('unwrapCustomToolInput preserves freeform newlines and quotes in the extracted input', () => {
  const wrapped = JSON.stringify({ input: '*** Begin Patch\n*** Update File: "foo.py"\n*** End Patch' });
  assertEquals(unwrapCustomToolInput(wrapped), '*** Begin Patch\n*** Update File: "foo.py"\n*** End Patch');
});

test('unwrapCustomToolInput falls back to the raw blob when JSON parse fails', () => {
  assertEquals(unwrapCustomToolInput('not json'), 'not json');
  assertEquals(unwrapCustomToolInput('{"input":"unterminated'), '{"input":"unterminated');
});

test('unwrapCustomToolInput falls back to the raw blob when input field is missing', () => {
  assertEquals(unwrapCustomToolInput('{"other":"value"}'), '{"other":"value"}');
});

test('unwrapCustomToolInput falls back to the raw blob when input field is not a string', () => {
  assertEquals(unwrapCustomToolInput('{"input":42}'), '{"input":42}');
  assertEquals(unwrapCustomToolInput('{"input":null}'), '{"input":null}');
  assertEquals(unwrapCustomToolInput('{"input":{"nested":"obj"}}'), '{"input":{"nested":"obj"}}');
});
