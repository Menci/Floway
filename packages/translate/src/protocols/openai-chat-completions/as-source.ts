import { restateOpenAIChatCompletionsError } from './as-source/error-body.ts';
import { continuousUsageOf, openaiChatCompletionsRead } from './as-source/input-to.ts';
import { collectOpenAIChatCompletionsReplayContents, findOpenAIChatCompletionsSidecarCarriers, verifyOpenAIChatCompletionsTurnDigest } from './as-source/round-trip.ts';
import { openaiChatCompletionsFromIR } from './as-source/sse-to.ts';
import type { SourceProtocol } from '../../composition/index.ts';
import type { OpenAIChatCompletionsPayloadEx, OpenAIChatCompletionsStreamEvent } from '@floway-dev/protocols/openai-chat-completions';

/**
 * Chat Completions read as the side a request comes from.
 *
 * A Chat assistant turn holds exactly one message, so the structure a sidecar
 * describes is that message.
 */
export const openaiChatCompletionsSourceProtocol: SourceProtocol<
  'openaiChatCompletions', OpenAIChatCompletionsPayloadEx, OpenAIChatCompletionsStreamEvent
> = {
  name: 'openaiChatCompletions',
  read: openaiChatCompletionsRead,
  sidecarRecognition: {
    inspect: findOpenAIChatCompletionsSidecarCarriers,
    verify: verifyOpenAIChatCompletionsTurnDigest,
    collectCandidates: collectOpenAIChatCompletionsReplayContents,
  },
  restateUpstreamError: restateOpenAIChatCompletionsError,
  // The client's own rendering choice, read off the request it sent.
  writeStream: (payload, records, roundTrip) => openaiChatCompletionsFromIR(records, {
    continuousUsageStats: continuousUsageOf(payload),
    roundTrip,
  }),
};
