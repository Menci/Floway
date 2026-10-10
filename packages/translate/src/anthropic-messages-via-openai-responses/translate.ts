import { translateToSourceEvents } from './events.ts';
import { buildRoundTripTargetRequest } from './request.ts';
import { rewriteContextExceededToPromptTooLong } from '../shared/anthropic-messages-via/context-window-error.ts';
import type { TranslateTrip } from '../types.ts';
import type { AnthropicMessagesPayload, AnthropicMessagesStreamEventEx } from '@floway-dev/protocols/anthropic-messages';
import type { CanonicalOpenAIResponsesPayload, OpenAIResponsesStreamEventEx } from '@floway-dev/protocols/openai-responses';

export const translateAnthropicMessagesViaOpenAIResponses: TranslateTrip<
  AnthropicMessagesPayload, AnthropicMessagesStreamEventEx, CanonicalOpenAIResponsesPayload, OpenAIResponsesStreamEventEx
> = async (src, ctx) => ({
  target: await buildRoundTripTargetRequest(src, ctx.assistantTurnSidecar),
  events: frames => translateToSourceEvents(frames, ctx.assistantTurnSidecar),
  apiError: rewriteContextExceededToPromptTooLong,
});
