import type { SourceProtocol } from '../composition.ts';
import { openaiChatCompletionsErrorWriter } from './as-source/error-body.ts';
import { openaiChatCompletionsRead } from './as-source/input-to.ts';
import { collectOpenAIChatCompletionsReplayContents, findOpenAIChatCompletionsSidecarCarriers, verifyOpenAIChatCompletionsTurnDigest } from './as-source/round-trip.ts';
import { openaiChatCompletionsFromIR } from './as-source/sse-to.ts';
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
  roundTrip: {
    inspect: findOpenAIChatCompletionsSidecarCarriers,
    verify: verifyOpenAIChatCompletionsTurnDigest,
    collectCandidates: collectOpenAIChatCompletionsReplayContents,
  },
  writeError: openaiChatCompletionsErrorWriter,
  // The preference the reader recorded when the trip was built, so a payload
  // the caller mutates afterwards cannot change what this trip states back.
  writeStream: (reading, _payload, records, roundTrip) => openaiChatCompletionsFromIR(records, {
    continuousUsageStats: reading.request.settings.continuous_usage === true,
    roundTrip,
  }),
};
