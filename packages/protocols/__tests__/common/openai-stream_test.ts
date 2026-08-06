import { test } from 'vitest';

import { isOpenAIUsageOnlyEventShape } from '../../src/common/openai-stream.ts';
import { assertEquals } from '@floway-dev/test-utils';

test('isOpenAIUsageOnlyEventShape identifies the OpenAI / vanilla-vLLM shape (empty choices + usage)', () => {
  assertEquals(isOpenAIUsageOnlyEventShape({ choices: [], usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 } }), true);
});

test('isOpenAIUsageOnlyEventShape identifies a contentless placeholder choice with usage', () => {
  assertEquals(isOpenAIUsageOnlyEventShape({ choices: [{ index: 0 }], usage: { prompt_tokens: 4, completion_tokens: 20, total_tokens: 24 } }), true);
});

test('isOpenAIUsageOnlyEventShape rejects content chunks even when the upstream stamps a placeholder usage on each one', () => {
  // Ollama emits `usage: {0, 0, 0}` on every streaming content chunk and
  // saves the real numbers for a final `choices: []` chunk. The mid-stream
  // chunks must NOT be misidentified.
  assertEquals(
    isOpenAIUsageOnlyEventShape({
      choices: [{ index: 0, text: 'hi', finish_reason: null }],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    }),
    false,
  );
});

test('isOpenAIUsageOnlyEventShape rejects the finish-reason chunk even with placeholder usage on it', () => {
  // Same Ollama pattern: a chunk whose only choice carries finish_reason
  // but no content is structurally distinct from the usage chunk — the
  // client needs the finish_reason signal.
  assertEquals(
    isOpenAIUsageOnlyEventShape({
      choices: [{ index: 0, text: '', finish_reason: 'length' }],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    }),
    false,
  );
});

test('isOpenAIUsageOnlyEventShape rejects chat-completions delta chunks with content', () => {
  assertEquals(
    isOpenAIUsageOnlyEventShape({
      choices: [{ index: 0, delta: { role: 'assistant', content: 'hi' } }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }),
    false,
  );
});

test('isOpenAIUsageOnlyEventShape rejects bare-usage rows without choices and any non-object inputs', () => {
  assertEquals(isOpenAIUsageOnlyEventShape({ usage: { total_tokens: 1 } }), false);
  assertEquals(isOpenAIUsageOnlyEventShape({ choices: [], usage: undefined }), false);
  assertEquals(isOpenAIUsageOnlyEventShape({ choices: [], usage: null }), false);
  assertEquals(isOpenAIUsageOnlyEventShape({ choices: [] }), false);
  assertEquals(isOpenAIUsageOnlyEventShape(null), false);
  assertEquals(isOpenAIUsageOnlyEventShape(undefined), false);
  assertEquals(isOpenAIUsageOnlyEventShape('not an event'), false);
  assertEquals(isOpenAIUsageOnlyEventShape(42), false);
});

test('isOpenAIUsageOnlyEventShape never hides malformed or future choice content', () => {
  assertEquals(isOpenAIUsageOnlyEventShape({ choices: [], usage: 0 }), false);
  assertEquals(isOpenAIUsageOnlyEventShape({ choices: [], usage: [] }), false);
  assertEquals(isOpenAIUsageOnlyEventShape({ choices: [{ index: 0, text: 1 }], usage: {} }), false);
  assertEquals(isOpenAIUsageOnlyEventShape({ choices: [{ index: 0, delta: [] }], usage: {} }), false);
  assertEquals(isOpenAIUsageOnlyEventShape({ choices: [{ index: 0, vendor_delta: 'future content' }], usage: {} }), false);
  assertEquals(isOpenAIUsageOnlyEventShape({ choices: [{ index: 0, logprobs: { tokens: [] } }], usage: {} }), false);
});
