import { test } from 'vitest';

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

test('unwrapCustomToolInput falls back to the raw blob when JSON parse fails', () => {
  assertEquals(unwrapCustomToolInput('not json'), 'not json');
  assertEquals(unwrapCustomToolInput('{"input":"unterminated'), '{"input":"unterminated');
});
