import type { Fields } from './facts.ts';
import { isFailure } from '../../pipeline/facts.ts';
import { defineStage, transform, move } from '@floway-dev/pipeline';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import { isGeminiGenerateContentTerminalEvent, GEMINI_GENERATE_CONTENT_MISSING_TERMINAL_MESSAGE, type GeminiGenerateContentStreamEvent } from '@floway-dev/protocols/gemini-generate-content';

/**
 * Says where a Gemini generateContent turn ends, on the frames the client is handed rather than on the wire
 * below them.
 *
 * The two are not the same statement. An OpenAI Chat Completions stream that closed cleanly without
 * ever reporting a finish reason ends its own dialect properly and translates into candidates
 * that never finish, and serving those would report a truncated answer as a whole one. So the
 * turn's end is read here, where the protocol the client speaks is, and the wire's end is read
 * on the wire.
 *
 * It sits below the thought suppressor and above the fork: what it truncates is what the rules
 * above it then work on, which is the order the fused ending had.
 */
export const requireGeminiGenerateContentTerminal = defineStage<
  Record<string, never>,
  Record<string, never>,
  Fields<'response.chat.geminiGenerateContent'>,
  Fields<'response.chat.geminiGenerateContent'>
>({
  name: 'requireGeminiGenerateContentTerminal',
  through: {
    request: { needs: [], consumes: [], provides: [] },
    response: { needs: ['response.chat.geminiGenerateContent'], consumes: [], provides: ['response.chat.geminiGenerateContent'] },
  },
  execute: transform<
    Record<string, never>,
    Record<string, never>,
    Fields<'response.chat.geminiGenerateContent'>,
    Fields<'response.chat.geminiGenerateContent'>
  >(() => ({
    response: facts => {
      const answer = facts['response.chat.geminiGenerateContent'];
      // A refusal and a collected body never opened a stream, so there is no end to find.
      if (isFailure(answer) || answer.kind !== 'stream') return facts;
      const frames = answer.frames as AsyncIterable<ProtocolFrame<GeminiGenerateContentStreamEvent>>;
      return {
        ...facts,
        'response.chat.geminiGenerateContent': move({
          kind: 'stream' as const,
          frames: { [Symbol.asyncIterator]: () => framesUntilTerminal(frames) },
        }),
      };
    },
  })),
});

/** Stops at the frame that ends the turn — there is nothing further to read, and returning
 *  here closes the translation and the wire under it — and fails a stream that ran out before
 *  one arrived. */
const framesUntilTerminal = async function* (
  frames: AsyncIterable<ProtocolFrame<GeminiGenerateContentStreamEvent>>,
): AsyncGenerator<ProtocolFrame<GeminiGenerateContentStreamEvent>> {
  for await (const frame of frames) {
    yield frame;
    if (frame.type === 'done' || isGeminiGenerateContentTerminalEvent(frame.event)) return;
  }
  throw new Error(GEMINI_GENERATE_CONTENT_MISSING_TERMINAL_MESSAGE);
};
