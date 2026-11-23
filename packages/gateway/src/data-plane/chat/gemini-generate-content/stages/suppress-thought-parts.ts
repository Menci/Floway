import type { ChatOutcomeFacts, ChatPayloadFacts } from '../../shared/route-body.ts';
import type { TargetRequest } from '../../shared/target-picker.ts';
import { isTransportFailure } from '@floway-dev/http';
import { defineStage } from '@floway-dev/pipeline';
import { eventFrame } from '@floway-dev/protocols/common';
import type { GeminiGenerateContentStreamEvent } from '@floway-dev/protocols/gemini-generate-content';
import type { ProviderFrame } from '@floway-dev/provider';

type Request = ChatPayloadFacts<'geminiGenerateContent'> & TargetRequest;
type Response = ChatOutcomeFacts<'geminiGenerateContent'>;

const hasEventPayload = (event: GeminiGenerateContentStreamEvent): boolean =>
  'error' in event || (event.candidates?.length ?? 0) > 0
  || event.usageMetadata !== undefined || event.modelVersion !== undefined
  || event.responseId !== undefined || event.promptFeedback !== undefined || event.modelStatus !== undefined;

const withoutThoughts = async function* (source: AsyncIterable<ProviderFrame<GeminiGenerateContentStreamEvent>>) {
  for await (const frame of source) {
    if (isTransportFailure(frame) || frame.type === 'done' || 'error' in frame.event) {
      yield frame;
      continue;
    }
    const candidates = frame.event.candidates?.flatMap(candidate => {
      if (candidate.content?.parts === undefined) return [candidate];
      const parts = candidate.content.parts.filter(part => part.thought !== true);
      if (!parts.length && candidate.finishReason === undefined) return [];
      return [{ ...candidate, content: { ...candidate.content, parts } }];
    });
    const event = { ...frame.event, ...(candidates === undefined ? {} : { candidates }) };
    if (hasEventPayload(event)) yield eventFrame(event);
  }
};

export const suppressThoughtParts = defineStage<Request, Request, Response, Response>({
  name: 'suppressThoughtParts',
  through: {
    request: { needs: ['request.geminiGenerateContent', 'route.targetApi'], consumes: [], provides: [] },
    response: { needs: ['response.geminiGenerateContent'], consumes: [], provides: ['response.geminiGenerateContent'] },
  },
  execute: async (facts, scope) => {
    const response = await scope.next(facts);
    const outcome = response['response.geminiGenerateContent'];
    const includeThoughts = facts['request.geminiGenerateContent'].generationConfig?.thinkingConfig?.includeThoughts;
    return outcome.kind !== 'stream' || facts['route.targetApi'] === 'geminiGenerateContent' || includeThoughts === true ? response : {
      ...response,
      'response.geminiGenerateContent': {
        ...outcome,
        events: scope.wrapStream(outcome.events, { label: 'suppressThoughtParts', transform: withoutThoughts }),
      },
    };
  },
});
