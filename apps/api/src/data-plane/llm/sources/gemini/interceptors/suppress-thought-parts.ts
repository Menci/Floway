import type { GeminiInterceptor } from '../../../interceptors.ts';
import { eventFrame, type ProtocolFrame } from '@floway-dev/protocols/common';
import type { GeminiStreamEvent } from '@floway-dev/protocols/gemini';

const hasEventPayload = (event: GeminiStreamEvent): boolean => {
  if ('error' in event) return true;
  return (event.candidates?.length ?? 0) > 0 || event.usageMetadata !== undefined || event.modelVersion !== undefined || event.responseId !== undefined;
};

const suppressThoughtPartsFromFrames = async function* (frames: AsyncIterable<ProtocolFrame<GeminiStreamEvent>>): AsyncGenerator<ProtocolFrame<GeminiStreamEvent>> {
  for await (const frame of frames) {
    if (frame.type !== 'event' || 'error' in frame.event) {
      yield frame;
      continue;
    }

    const candidates = frame.event.candidates?.flatMap(candidate => {
      const parts = candidate.content.parts.filter(part => part.thought !== true);
      if (!parts.length && candidate.finishReason === undefined) return [];

      return [
        {
          ...candidate,
          content: { ...candidate.content, parts },
        },
      ];
    });

    const event: GeminiStreamEvent = {
      ...frame.event,
      ...(candidates !== undefined ? { candidates } : {}),
    };

    if (hasEventPayload(event)) yield eventFrame(event);
  }
};

/**
 * Hide Gemini thought-summary parts unless the caller explicitly opted in via
 * `generationConfig.thinkingConfig.includeThoughts === true`.
 */
export const suppressThoughtParts: GeminiInterceptor = async (ctx, _request, run) => {
  const result = await run();
  if (result.type !== 'events' || ctx.payload.generationConfig?.thinkingConfig?.includeThoughts === true) {
    return result;
  }

  return { ...result, events: suppressThoughtPartsFromFrames(result.events) };
};
