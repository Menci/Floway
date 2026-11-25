import { expect, test } from 'vitest';

import { guardToolArgumentWhitespace } from '../../../src/pipelines/openai-chat-completions/guard-tool-argument-whitespace.ts';
import { MAX_CONSECUTIVE_WHITESPACE } from '../../../src/pipelines/shared/whitespace-overflow.ts';
import { inspectStages } from '../inspect.ts';
import type { OpenAIChatCompletionsStreamEvent } from '@floway-dev/protocols/openai-chat-completions';

const toolChunk = (choices: OpenAIChatCompletionsStreamEvent['choices']): OpenAIChatCompletionsStreamEvent => ({
  id: 'chatcmpl_1', object: 'chat.completion.chunk', created: 0, model: 'test-model', choices,
});

const observe = (events: AsyncIterable<OpenAIChatCompletionsStreamEvent> | Iterable<OpenAIChatCompletionsStreamEvent>) =>
  inspectStages('openaiChatCompletions', guardToolArgumentWhitespace, { payload: { model: 'test-model', messages: [] } },
    ({ stream }) => ({ kind: 'stream', stream: stream(events) }));

test('returns a protocol failure and drains the source even when it still has frames', async () => {
  const chunk = toolChunk([{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '\n'.repeat(MAX_CONSECUTIVE_WHITESPACE + 1) } }] }, finish_reason: null }]);
  let drained = false;
  const source = (async function* () {
    yield chunk;
    yield chunk;
    drained = true;
  })();
  const result = await observe(source);
  expect(result.items).toEqual([{ ok: false, error: { kind: 'protocol', cause: expect.objectContaining({ message: expect.stringContaining('whitespace') }) } }]);
  await expect.poll(() => drained).toBe(true);
});

test('tracks whitespace per choice and call independently', async () => {
  const args = '\n'.repeat(MAX_CONSECUTIVE_WHITESPACE);
  const chunk = toolChunk([0, 1].map(index => ({
    index,
    delta: { tool_calls: [0, 1].map(call => ({ index: call, function: { arguments: args } })) },
    finish_reason: null,
  })));
  const result = await observe([chunk]);
  expect(result.items).toEqual([{ ok: true, value: chunk }]);
});
