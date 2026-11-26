import { test } from 'vitest';

import { withOutputCapRenamed } from '../../../src/interceptors/openai-chat-completions/rename-output-cap.ts';
import type { OpenAIChatCompletionsBoundaryCtx } from '../../../src/interceptors/openai-chat-completions/types.ts';
import type { OpenAIChatCompletionsStreamEvent } from '@floway-dev/protocols/openai-chat-completions';
import { assertEquals, stubUpstreamModel } from '@floway-dev/test-utils';
import type { UpstreamStreamResult } from '@floway-dev/upstream';

const boundary = (limits: { max_tokens?: number | null; max_completion_tokens?: number | null }): OpenAIChatCompletionsBoundaryCtx => ({
  payload: { messages: [{ role: 'user', content: 'hi' }], ...limits },
  model: stubUpstreamModel({ endpoints: { openaiChatCompletions: {} } }),
});

const stream = (): UpstreamStreamResult<OpenAIChatCompletionsStreamEvent> => ({
  ok: true,
  events: (async function* () {})(),
  modelKey: 'gpt-oss:120b',
});

// Ollama's shim has no `max_completion_tokens` field, so a cap expressed that
// way never reaches `num_predict`. The rename keeps the caller's number while
// leaving a payload that already speaks the legacy field alone.
test.each([
  { limits: { max_completion_tokens: 0 }, expected: { max_tokens: 0 } },
  { limits: { max_tokens: null, max_completion_tokens: 128000 }, expected: { max_tokens: null, max_completion_tokens: 128000 } },
])('Ollama maps the modern output cap onto its legacy field for $limits', async ({ limits, expected }) => {
  const ctx = boundary(limits);
  const next = stream();
  const run = async () => {
    assertEquals(ctx.payload, { messages: [{ role: 'user', content: 'hi' }], ...expected });
    return next;
  };
  assertEquals(await withOutputCapRenamed(ctx, {}, run), next);
});
