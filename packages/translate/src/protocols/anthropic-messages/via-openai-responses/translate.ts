import { translateToSourceEvents } from './events.ts';
import { buildTargetRequest } from './request.ts';
import { TranslateInputException } from '../../../shared/input-error.ts';
import type { Translator } from '../../../types.ts';
import { restateAnthropicMessagesError } from '../as-source/error-body.ts';
import type { AnthropicMessagesPayload, AnthropicMessagesStreamEventEx } from '@floway-dev/protocols/anthropic-messages';
import type { CanonicalOpenAIResponsesPayload, OpenAIResponsesStreamEventEx } from '@floway-dev/protocols/openai-responses';

export const translate: Translator<
  AnthropicMessagesPayload, AnthropicMessagesStreamEventEx, CanonicalOpenAIResponsesPayload, OpenAIResponsesStreamEventEx
> = async (src, ctx) => {
  try {
    return {
      type: 'trip',
      target: await buildTargetRequest(src, ctx.sidecarCodec),
      events: frames => translateToSourceEvents(frames, ctx.sidecarCodec),
      error: restateAnthropicMessagesError,
    };
  } catch (error) {
    if (error instanceof TranslateInputException) return error.failure;
    throw error;
  }
};
