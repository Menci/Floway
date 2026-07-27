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

test('chatCompletionsProtocolFrameToSSEFrame serializes DONE without owning termination', () => {
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
  ].map(frame => chatCompletionsProtocolFrameToSSEFrame(frame, includeUsageChunk));

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
