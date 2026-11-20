import { asJsonObject } from '../../../shared/json-helpers.ts';
import type { Chat } from '../facts.ts';
import { answerWithFrames } from '../shared/frames.ts';
import { defineStage, transform, move } from '@floway-dev/pipeline';
import { eventFrame, type ProtocolFrame } from '@floway-dev/protocols/common';
import type { OpenAIChatCompletionsStreamEvent } from '@floway-dev/protocols/openai-chat-completions';

/**
 * Puts a usage block back on the carrier chunk the spec says it arrives on.
 *
 * OpenAI puts the final `usage` on a `choices: []` chunk of its own
 * (https://platform.openai.com/docs/api-reference/chat-streaming), and some upstreams have
 * been observed to attach it to the same chunk that carries the last delta and
 * `finish_reason`. Such a chunk is split in two — the delta as it arrived, then a synthesized
 * carrier holding the usage — so everything downstream can rely on the standard shape.
 *
 * It runs above the vendor normalizers, so on the way back it sees a usage block whose cache
 * fields already carry OpenAI's names.
 */
export const normalizeUsageForOpenAIChatCompletions = defineStage<
  Record<string, never>,
  Record<string, never>,
  Chat<'response.chat.openaiChatCompletions'>,
  Chat<'response.chat.openaiChatCompletions'>
>({
  name: 'normalizeUsage',
  through: {
    request: { needs: [], consumes: [], provides: [] },
    response: {
      needs: ['response.chat.openaiChatCompletions'],
      consumes: [],
      provides: ['response.chat.openaiChatCompletions'],
    },
  },
  execute: transform<
    Record<string, never>,
    Record<string, never>,
    Chat<'response.chat.openaiChatCompletions'>,
    Chat<'response.chat.openaiChatCompletions'>
  >(() => ({
    response: facts => {
      const answer = answerWithFrames<OpenAIChatCompletionsStreamEvent>(facts['response.chat.openaiChatCompletions'], withUsageOnItsOwnCarrier);
      return answer === null ? facts : { ...facts, 'response.chat.openaiChatCompletions': move(answer) };
    },
  })),
});

/** One chunk in, two out — and only for the chunk that carried both, which is why this is not
 *  a one-for-one event rewrite. */
const withUsageOnItsOwnCarrier = async function* (
  frames: AsyncIterable<ProtocolFrame<OpenAIChatCompletionsStreamEvent>>,
): AsyncGenerator<ProtocolFrame<OpenAIChatCompletionsStreamEvent>> {
  for await (const frame of frames) {
    if (frame.type !== 'event') {
      yield frame;
      continue;
    }
    const chunk = frame.event;
    if (asJsonObject(chunk.usage) === null || chunk.choices.length === 0) {
      yield frame;
      continue;
    }
    const { usage, ...withoutUsage } = chunk;
    yield eventFrame(withoutUsage);
    yield eventFrame({ ...withoutUsage, choices: [], usage });
  }
};
