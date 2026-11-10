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
  writeStream: (reading, _payload, records, writer) => openaiChatCompletionsFromIR(records, {
    continuousUsageStats: reading.request.settings.continuous_usage === true,
    roundTrip: writer,
  }),
};
