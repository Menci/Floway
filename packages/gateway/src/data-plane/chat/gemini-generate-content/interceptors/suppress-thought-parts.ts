import type { GeminiGenerateContentInterceptor } from './types.ts';
import { eventFrame, type ProtocolFrame } from '@floway-dev/protocols/common';
import type { GeminiGenerateContentStreamEvent } from '@floway-dev/protocols/gemini-generate-content';

const hasEventPayload = (event: GeminiGenerateContentStreamEvent): boolean => {
  if ('error' in event) return true;
  return (event.candidates?.length ?? 0) > 0 || event.usageMetadata !== undefined || event.modelVersion !== undefined || event.responseId !== undefined;
};

const suppressThoughtPartsFromFrames = async function* (frames: AsyncIterable<ProtocolFrame<GeminiGenerateContentStreamEvent>>): AsyncGenerator<ProtocolFrame<GeminiGenerateContentStreamEvent>> {
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

    const event: GeminiGenerateContentStreamEvent = {
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
export const suppressThoughtParts: GeminiGenerateContentInterceptor = async (ctx, _gatewayCtx, run) => {
  const result = await run();
  if (result.type !== 'events' || ctx.payload.generationConfig?.thinkingConfig?.includeThoughts === true) {
    return result;
  }

  return { ...result, events: suppressThoughtPartsFromFrames(result.events) };
};
