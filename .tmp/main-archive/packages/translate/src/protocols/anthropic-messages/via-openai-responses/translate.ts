import { translateToSourceEvents } from './events.ts';
import { buildTargetRequest } from './request.ts';
import type { TranslateTrip } from '../../../types.ts';
import { rewriteContextExceededToPromptTooLong } from '../as-source/context-window-error.ts';
import type { AnthropicMessagesPayload, AnthropicMessagesStreamEventEx } from '@floway-dev/protocols/anthropic-messages';
import type { CanonicalOpenAIResponsesPayload, OpenAIResponsesStreamEventEx } from '@floway-dev/protocols/openai-responses';

export const translate: TranslateTrip<
  AnthropicMessagesPayload, AnthropicMessagesStreamEventEx, CanonicalOpenAIResponsesPayload, OpenAIResponsesStreamEventEx
> = async (src, ctx) => {
  return {
    target: await buildTargetRequest(src, ctx.sidecarCodec),
    events: frames => translateToSourceEvents(frames, ctx.sidecarCodec),
    apiError: rewriteContextExceededToPromptTooLong,
  };
};
