import { defineStage } from '../../../pipeline/facts.ts';
import type { GeminiGenerateContentStreamEvent } from '@floway-dev/protocols/gemini-generate-content';

const hasEventPayload = (event: GeminiGenerateContentStreamEvent): boolean => {
  if ('error' in event) return true;
  return (event.candidates?.length ?? 0) > 0 || event.usageMetadata !== undefined || event.modelVersion !== undefined || event.responseId !== undefined || event.promptFeedback !== undefined || event.modelStatus !== undefined;
};

const stripThoughts = (event: GeminiGenerateContentStreamEvent): GeminiGenerateContentStreamEvent | undefined => {
  if ('error' in event) return event;
  const candidates = event.candidates?.flatMap(candidate => {
    if (candidate.content?.parts === undefined) return [candidate];
    const parts = candidate.content.parts.filter(part => part.thought !== true);
    if (!parts.length && candidate.finishReason === undefined) return [];

    return [
      {
        ...candidate,
        content: { ...candidate.content, parts },
      },
    ];
  });

  const filtered = { ...event, ...(candidates === undefined ? {} : { candidates }) };
  return hasEventPayload(filtered) ? filtered : undefined;
};

/**
 * Hide thought-summary parts that a translated target surfaced unless the
 * caller opted in via `generationConfig.thinkingConfig.includeThoughts`. A
 * native Gemini upstream decides that itself from the same flag, and its own
 * stream reaches the client untouched.
 */
export const suppressThoughtParts = defineStage({
  name: 'geminiGenerateContent.suppress-thought-parts',
  through: {
    request: { needs: ['request.geminiGenerateContent', 'provider.model'], provides: [], consumes: [] },
    response: { needs: ['response.geminiGenerateContent'], provides: ['response.geminiGenerateContent'], consumes: [] },
  },
  async execute(facts, scope) {
    const answer = await scope.next(facts);
    const outcome = answer['response.geminiGenerateContent'];
    if (outcome.kind !== 'stream'
      || facts['provider.model'].endpoints.geminiGenerateContent !== undefined
      || facts['request.geminiGenerateContent'].generationConfig?.thinkingConfig?.includeThoughts === true) return answer;
    const stream = scope.wrapStream(outcome.stream, async function* (inner, producer) {
      for await (const item of producer.read(inner)) {
        if (!item.ok) {
          producer.discard(inner);
          yield item;
          return;
        }
        const event = stripThoughts(item.value);
        if (event !== undefined) yield { ok: true, value: event };
      }
    });
    return { ...answer, 'response.geminiGenerateContent': { kind: 'stream', stream } };
  },
});
