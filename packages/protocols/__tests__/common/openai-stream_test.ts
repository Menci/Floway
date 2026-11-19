import { test } from 'vitest';

import { isOpenAIUsageOnlyEventShape } from '../../src/common/openai-stream.ts';
import { assertEquals } from '@floway-dev/test-utils';

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
