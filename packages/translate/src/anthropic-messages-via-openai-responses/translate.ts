import { translateToSourceEvents } from './events.ts';
import { buildTargetRequest } from './request.ts';
import { rewriteContextExceededToPromptTooLong } from '../shared/anthropic-messages-via/context-window-error.ts';
import type { TranslateTrip } from '../types.ts';
import type { AnthropicMessagesPayload, AnthropicMessagesStreamEvent } from '@floway-dev/protocols/anthropic-messages';
import type { CanonicalOpenAIResponsesPayload, OpenAIResponsesStreamEvent } from '@floway-dev/protocols/openai-responses';

export const translateAnthropicMessagesViaOpenAIResponses: TranslateTrip<
  AnthropicMessagesPayload, AnthropicMessagesStreamEvent, CanonicalOpenAIResponsesPayload, OpenAIResponsesStreamEvent
> = async src => ({
  target: buildTargetRequest(src),
  events: frames => translateToSourceEvents(frames, src.tools?.find(tool => tool.type === 'tool_search_tool_regex_20251119' || tool.type === 'tool_search_tool_bm25_20251119')?.name),
  apiError: rewriteContextExceededToPromptTooLong,
});
