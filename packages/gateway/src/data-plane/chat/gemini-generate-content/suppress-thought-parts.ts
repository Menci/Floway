import { isFailure } from '../../pipeline/facts.ts';
import type { Chat } from '../facts.ts';
import { defineStage, transform, move } from '@floway-dev/pipeline';
import { eventFrame, type ProtocolFrame } from '@floway-dev/protocols/common';
import type { GeminiGenerateContentStreamEvent } from '@floway-dev/protocols/gemini-generate-content';

/**
 * Hides Gemini generateContent thought-summary parts from a caller who did not ask for them.
 *
 * The opt-in is `generationConfig.thinkingConfig.includeThoughts`, which is something the
 * client sent — a request-direction reading — and the rule that uses it runs on the way back.
 * So it rides in this stage's own closure rather than as a declaration: a response-side
 * `needs` can only name what the ending provides, which is the answer and not the turn.
 */
export const suppressThoughtPartsFromGeminiGenerateContent = defineStage<
  Chat<'request.chat.geminiGenerateContent'>,
  Chat<'request.chat.geminiGenerateContent'>,
  Chat<'response.chat.geminiGenerateContent'>,
  Chat<'response.chat.geminiGenerateContent'>
>({
  name: 'suppressThoughtParts',
  through: {
    request: { needs: ['request.chat.geminiGenerateContent'], consumes: [], provides: [] },
    response: { needs: ['response.chat.geminiGenerateContent'], consumes: [], provides: ['response.chat.geminiGenerateContent'] },
  },
  execute: transform<
    Chat<'request.chat.geminiGenerateContent'>,
    Chat<'request.chat.geminiGenerateContent'>,
    Chat<'response.chat.geminiGenerateContent'>,
    Chat<'response.chat.geminiGenerateContent'>
  >(() => {
    // Assigned on the way down and read on the way back, which is the order `transform` runs
    // the two halves in.
    let includeThoughts!: boolean;
    return {
      request: facts => {
        includeThoughts = facts['request.chat.geminiGenerateContent'].generationConfig?.thinkingConfig?.includeThoughts === true;
        return facts;
      },
      response: facts => {
        if (includeThoughts) return facts;
        const answer = facts['response.chat.geminiGenerateContent'];
        // A refusal and a collected body have no thought parts to hide, and telling the three
        // apart is reading a value rather than dispatching on a declaration.
        if (isFailure(answer) || answer.kind !== 'stream') return facts;
        const frames = answer.frames as AsyncIterable<ProtocolFrame<GeminiGenerateContentStreamEvent>>;
        return {
          ...facts,
          'response.chat.geminiGenerateContent': move({
            kind: 'stream' as const,
            frames: { [Symbol.asyncIterator]: () => withoutThoughtParts(frames) },
          }),
        };
      },
    };
  }),
});

/** A candidate that has nothing left to say and has not finished is not a candidate, and an
 *  event left carrying no candidate, no usage, no model and no id is not an event — dropping
 *  both is what keeps a stream of pure thought from reaching the client as a stream of
 *  empties. */
const withoutThoughtParts = async function* (
  frames: AsyncIterable<ProtocolFrame<GeminiGenerateContentStreamEvent>>,
): AsyncGenerator<ProtocolFrame<GeminiGenerateContentStreamEvent>> {
  for await (const frame of frames) {
    if (frame.type !== 'event' || 'error' in frame.event) {
      yield frame;
      continue;
    }

    const candidates = frame.event.candidates?.flatMap(candidate => {
      const parts = candidate.content.parts.filter(part => part.thought !== true);
      if (!parts.length && candidate.finishReason === undefined) return [];
      return [{ ...candidate, content: { ...candidate.content, parts } }];
    });

    const event: GeminiGenerateContentStreamEvent = {
      ...frame.event,
      ...(candidates === undefined ? {} : { candidates }),
    };
    if (hasGeminiGenerateContentEventPayload(event)) yield eventFrame(event);
  }
};

const hasGeminiGenerateContentEventPayload = (event: GeminiGenerateContentStreamEvent): boolean => {
  if ('error' in event) return true;
  return (event.candidates?.length ?? 0) > 0
    || event.usageMetadata !== undefined
    || event.modelVersion !== undefined
    || event.responseId !== undefined;
};
