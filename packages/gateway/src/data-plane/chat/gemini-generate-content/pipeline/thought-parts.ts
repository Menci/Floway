import { defineStage } from '../../pipeline/facts.ts';
import { mapProtocolEvents } from '../../pipeline/stream-transform.ts';
import type { GeminiGenerateContentStreamEvent } from '@floway-dev/protocols/gemini-generate-content';

const withoutThoughts = (event: GeminiGenerateContentStreamEvent): GeminiGenerateContentStreamEvent | undefined => {
  if ('error' in event) return event;
  const candidates = event.candidates?.flatMap(candidate => {
    if (candidate.content?.parts === undefined) return [candidate];
    const parts = candidate.content.parts.filter(part => part.thought !== true);
    return parts.length === 0 && candidate.finishReason === undefined ? [] : [{ ...candidate, content: { ...candidate.content, parts } }];
  });
  if ((candidates?.length ?? 0) === 0 && event.usageMetadata === undefined && event.modelVersion === undefined
    && event.responseId === undefined && event.promptFeedback === undefined && event.modelStatus === undefined) return undefined;
  return candidates === undefined ? event : { ...event, candidates };
};

export const suppressGeminiGenerateContentThoughtParts = defineStage({
  name: 'geminiGenerateContent.suppress-thought-parts',
  through: {
    request: { needs: ['geminiGenerateContent', 'chat.target'], provides: [], consumes: [] },
    response: { needs: ['geminiGenerateContent'], provides: ['geminiGenerateContent'], consumes: [] },
  },
  async execute(facts, scope) {
    const answer = await scope.next(facts);
    if (answer.geminiGenerateContent.kind !== 'stream' || facts['chat.target'] === 'geminiGenerateContent'
      || facts.geminiGenerateContent.generationConfig?.thinkingConfig?.includeThoughts === true) return answer;
    const stream = scope.wrapStream(answer.geminiGenerateContent.stream, (source, producer) => mapProtocolEvents(source, producer, withoutThoughts));
    return { ...answer, geminiGenerateContent: { kind: 'stream', stream } };
  },
});
