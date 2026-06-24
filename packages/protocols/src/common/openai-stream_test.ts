import { test } from 'vitest';

import { isOpenAIUsageOnlyEventShape } from './openai-stream.ts';
import { assertEquals } from '../test-assert.ts';

test('isOpenAIUsageOnlyEventShape identifies the OpenAI / vanilla-vLLM shape (empty choices + usage)', () => {
  assertEquals(isOpenAIUsageOnlyEventShape({ choices: [], usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 } }), true);
});

test('isOpenAIUsageOnlyEventShape identifies the Zhipu/GLM vLLM-fork shape (placeholder choice + usage)', () => {
  // Zhipu's vLLM fork (e.g. endpoint.runa.moe) emits the final usage chunk
  // with a one-element `choices` whose entry only carries `index` — no
  // `text`, no `delta`, no `finish_reason`. LiteLLM, One-API, New-API, and
  // Portkey all treat such an entry as a structural placeholder and key
  // off the usage block. Floway follows the same predicate so the chunk
  // is correctly captured for billing and stripped when the client did
  // not opt into include_usage.
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
