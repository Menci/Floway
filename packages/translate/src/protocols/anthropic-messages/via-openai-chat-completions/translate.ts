import { translateToSourceEvents } from './events.ts';
import { buildTargetRequest } from './request.ts';
import type { TranslateTrip } from '../../../types.ts';
import { anthropicMessagesErrorWriter } from '../as-source/error-body.ts';
import type { AnthropicMessagesPayload, AnthropicMessagesStreamEventEx } from '@floway-dev/protocols/anthropic-messages';
import type { OpenAIChatCompletionsStreamEvent, OpenAIChatCompletionsPayload } from '@floway-dev/protocols/openai-chat-completions';

export const translate: TranslateTrip<
  AnthropicMessagesPayload, AnthropicMessagesStreamEventEx, OpenAIChatCompletionsPayload, OpenAIChatCompletionsStreamEvent
> = async (src, ctx) => {
  const target = await buildTargetRequest(src, ctx.sidecarCodec);
  return {
    target,
    events: frames => translateToSourceEvents(frames, ctx.sidecarCodec, target.n ?? 1),
    errorBody: anthropicMessagesErrorWriter,
  };
};
