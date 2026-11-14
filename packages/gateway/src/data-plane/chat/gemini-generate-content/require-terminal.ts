import type { Fields } from './facts.ts';
import { isFailure } from '../../pipeline/facts.ts';
import { defineStage, transform, move } from '@floway-dev/pipeline';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import { createGeminiGenerateContentCandidateCompletion, isGeminiGenerateContentTerminalEvent, GEMINI_GENERATE_CONTENT_MISSING_TERMINAL_MESSAGE, type GeminiGenerateContentStreamEvent } from '@floway-dev/protocols/gemini-generate-content';

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

// Completion may precede usage and metadata, so validate at EOF rather than truncating
// on a finishReason. Error and prompt-block events end the turn immediately.
const framesUntilTerminal = async function* (
  frames: AsyncIterable<ProtocolFrame<GeminiGenerateContentStreamEvent>>,
): AsyncGenerator<ProtocolFrame<GeminiGenerateContentStreamEvent>> {
  const completion = createGeminiGenerateContentCandidateCompletion();
  for await (const frame of frames) {
    yield frame;
    if (frame.type === 'done' || isGeminiGenerateContentTerminalEvent(frame.event)) return;
    completion.observe(frame.event);
  }
  if (!completion.isComplete()) throw new Error(GEMINI_GENERATE_CONTENT_MISSING_TERMINAL_MESSAGE);
};
