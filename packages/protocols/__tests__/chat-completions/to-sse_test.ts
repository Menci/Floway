import { test } from 'vitest';

import type { ChatCompletionsStreamEvent } from '../../src/chat-completions/index.ts';
import { chatCompletionsProtocolFrameToSSEFrame } from '../../src/chat-completions/to-sse.ts';
import { doneFrame, eventFrame } from '../../src/common/index.ts';
import { assertEquals } from '@floway-dev/test-utils';

const includeUsageChunk = { includeUsageChunk: true };

test('chatCompletionsProtocolFrameToSSEFrame passes through non-chunk JSON payloads', () => {
  const payload = {
    error: { message: 'boom' },
  } as unknown as ChatCompletionsStreamEvent;

  const frame = chatCompletionsProtocolFrameToSSEFrame(eventFrame(payload), includeUsageChunk);

  assertEquals(frame, {
    type: 'sse',
    event: undefined,
    data: JSON.stringify(payload),
  });
});

test('chatCompletionsProtocolFrameToSSEFrame serializes DONE and filters only exact usage placeholders', () => {
  const chunk = {
    id: 'chatcmpl_done',
    object: 'chat.completion.chunk',
    created: 123,
    model: 'gpt-test',
    choices: [
      {
        index: 0,
        delta: { role: 'assistant', content: 'hello' },
        finish_reason: null,
      },
    ],
  } satisfies ChatCompletionsStreamEvent;

  assertEquals(chatCompletionsProtocolFrameToSSEFrame(eventFrame(chunk), includeUsageChunk)?.data, JSON.stringify(chunk));
  assertEquals(chatCompletionsProtocolFrameToSSEFrame(doneFrame(), includeUsageChunk)?.data, '[DONE]');

  const usage = { ...chunk, choices: [], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } };
  assertEquals(chatCompletionsProtocolFrameToSSEFrame(eventFrame(usage), { includeUsageChunk: false }), null);
  const futureContent = { ...usage, choices: [{ index: 0, vendor_delta: 'keep me' }] } as unknown as ChatCompletionsStreamEvent;
  assertEquals(chatCompletionsProtocolFrameToSSEFrame(eventFrame(futureContent), { includeUsageChunk: false })?.data, JSON.stringify(futureContent));
});
