import { test } from 'vitest';

import { isOpenAIUsageOnlyEventShape } from './openai-stream.ts';
import { assertEquals } from '../test-assert.ts';

test('isOpenAIUsageOnlyEventShape identifies the empty-choices-plus-usage chunk', () => {
  assertEquals(isOpenAIUsageOnlyEventShape({ choices: [], usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 } }), true);
});

test('isOpenAIUsageOnlyEventShape rejects content chunks and bare usage rows', () => {
  assertEquals(isOpenAIUsageOnlyEventShape({ choices: [{ index: 0, delta: { content: 'hi' } }], usage: { total_tokens: 1 } }), false);
  assertEquals(isOpenAIUsageOnlyEventShape({ choices: [], usage: undefined }), false);
  assertEquals(isOpenAIUsageOnlyEventShape({ choices: [], usage: null }), false);
  assertEquals(isOpenAIUsageOnlyEventShape({ usage: { total_tokens: 1 } }), false);
  assertEquals(isOpenAIUsageOnlyEventShape({ choices: [] }), false);
});

test('isOpenAIUsageOnlyEventShape rejects non-object inputs', () => {
  assertEquals(isOpenAIUsageOnlyEventShape(null), false);
  assertEquals(isOpenAIUsageOnlyEventShape(undefined), false);
  assertEquals(isOpenAIUsageOnlyEventShape('not an event'), false);
  assertEquals(isOpenAIUsageOnlyEventShape(42), false);
});
