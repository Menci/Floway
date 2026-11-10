import { test } from 'vitest';

import { buildCustomToolInputSchema } from '../../src/protocols/custom-tool.ts';
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

test('buildCustomToolInputSchema returns plain single-string schema when format.definition is empty', () => {
  assertEquals(buildCustomToolInputSchema({ type: 'grammar', syntax: 'lark', definition: '' }), {
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
