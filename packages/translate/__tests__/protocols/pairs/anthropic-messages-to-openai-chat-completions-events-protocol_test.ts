import { test } from 'vitest';

import { buildSourceEventsFor, emptyPayload, pairs } from '../../composition/helpers.ts';
import { createTestSidecarCodec } from '../../round-trip/sidecar-codec.ts';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import { eventFrame } from '@floway-dev/protocols/common';
import type { OpenAIChatCompletionsStreamEvent } from '@floway-dev/protocols/openai-chat-completions';

const codec = createTestSidecarCodec();
const translate = (frames: AsyncIterable<ProtocolFrame<OpenAIChatCompletionsStreamEvent>>) => buildSourceEventsFor(
  pairs.messagesToChat[0], pairs.messagesToChat[1], emptyPayload.messages, { sidecarCodec: codec }, frames,
);

const drain = async <T>(frames: AsyncIterable<T>): Promise<void> => {
  for await (const _frame of frames) {
    // Exhaust the stream so async translator errors surface to the caller.
  }
};

test('translateToSourceEvents accepts OpenAI Chat Completions streams without DONE', async () => {
  async function* stream() {
    yield eventFrame({
      id: 'chatcmpl_truncated',
      object: 'chat.completion.chunk',
      created: 123,
      model: 'gpt-test',
      choices: [
        {
          index: 0,
          delta: { role: 'assistant', content: 'partial' },
          finish_reason: 'stop',
        },
      ],
    } satisfies OpenAIChatCompletionsStreamEvent);
  }

  await drain(translate(stream()));
});
