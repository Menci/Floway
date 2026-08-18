import { test } from 'vitest';

import type { OpenAIChatCompletionsStreamEvent } from '../../src/openai-chat-completions/index.ts';
import { openaiChatCompletionsProtocolFrameToSSEFrame } from '../../src/openai-chat-completions/to-sse.ts';
import { doneFrame, eventFrame } from '../../src/common/index.ts';
import { assertEquals } from '@floway-dev/test-utils';

const includeUsageChunk = { includeUsageChunk: true };

test('openaiChatCompletionsProtocolFrameToSSEFrame passes through non-chunk JSON payloads', () => {
  const payload = {
    error: { message: 'boom' },
  } as unknown as OpenAIChatCompletionsStreamEvent;

  const frame = openaiChatCompletionsProtocolFrameToSSEFrame(eventFrame(payload), includeUsageChunk);

  assertEquals(frame, {
    type: 'sse',
    event: undefined,
    data: JSON.stringify(payload),
  });
});

test('openaiChatCompletionsProtocolFrameToSSEFrame serializes DONE without owning termination', () => {
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
  } satisfies OpenAIChatCompletionsStreamEvent;

  const frames = [
    eventFrame(chunk),
    doneFrame(),
    eventFrame({
      ...chunk,
      id: 'chatcmpl_after_done',
      choices: [
        {
          index: 0,
          delta: { content: 'ignored' },
          finish_reason: null,
        },
      ],
    }),
  ].map(frame => openaiChatCompletionsProtocolFrameToSSEFrame(frame, includeUsageChunk));

  assertEquals(
    frames.map(frame => frame?.data),
    [
      JSON.stringify(chunk),
      '[DONE]',
      JSON.stringify({
        ...chunk,
        id: 'chatcmpl_after_done',
        choices: [
          {
            index: 0,
            delta: { content: 'ignored' },
            finish_reason: null,
          },
        ],
      }),
    ],
  );
});
