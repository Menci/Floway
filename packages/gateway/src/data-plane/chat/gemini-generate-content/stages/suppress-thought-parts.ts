import type {
  ChatAttemptOutcome,
  ChatPipelineServices,
  GeminiGenerateContentAttemptInput,
} from '../../pipeline/index.ts';
import { defineStage } from '@floway-dev/pipeline';
import { eventFrame } from '@floway-dev/protocols/common';
import type { GeminiGenerateContentStreamEvent } from '@floway-dev/protocols/gemini-generate-content';
import type { ChatTargetApi } from '@floway-dev/provider';

interface Facts extends GeminiGenerateContentAttemptInput {
  readonly 'route.targetApi': ChatTargetApi;
}

const hasEventPayload = (event: GeminiGenerateContentStreamEvent): boolean => {
  if ('error' in event) return true;
  return (event.candidates?.length ?? 0) > 0
    || event.usageMetadata !== undefined
    || event.modelVersion !== undefined
    || event.responseId !== undefined
    || event.promptFeedback !== undefined
    || event.modelStatus !== undefined;
};

// Hide translated thought summaries unless the caller explicitly requested
// them. A native Gemini upstream applies the same flag itself.
export const suppressThoughtParts = defineStage<
  Facts,
  Record<never, never>,
  ChatAttemptOutcome<GeminiGenerateContentStreamEvent>,
  ChatAttemptOutcome<GeminiGenerateContentStreamEvent>,
  never,
  ChatPipelineServices
>({
  name: 'suppressThoughtParts',
  execute: async (facts, next, env) => {
    const outcome = await next();
    if (outcome.type !== 'events'
      || facts['route.targetApi'] === 'geminiGenerateContent'
      || facts['request.payload'].generationConfig?.thinkingConfig?.includeThoughts === true) {
      return outcome;
    }

    return {
      ...outcome,
      events: env.wrapStream(outcome.events, {
        label: 'gemini-generate-content.suppress-thought-parts',
        async *transform(source) {
          for await (const frame of source) {
            if (frame.type !== 'event' || 'error' in frame.event) {
              yield frame;
              continue;
            }
            const candidates = frame.event.candidates?.flatMap(candidate => {
              if (candidate.content?.parts === undefined) return [candidate];
              const parts = candidate.content.parts.filter(part => part.thought !== true);
              if (parts.length === 0 && candidate.finishReason === undefined) return [];
              return [{ ...candidate, content: { ...candidate.content, parts } }];
            });
            const event: GeminiGenerateContentStreamEvent = {
              ...frame.event,
              ...(candidates === undefined ? {} : { candidates }),
            };
            if (hasEventPayload(event)) yield eventFrame(event);
          }
        },
      }),
    };
  },
});
