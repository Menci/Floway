import { openaiChatCompletionsErrorWriter } from './as-source/error-body.ts';
import type { OpenAIChatCompletionsExtra } from './as-source/input-to.ts';
import { openaiChatCompletionsOpen } from './as-source/input-to.ts';
import { collectOpenAIChatCompletionsReplayContents, findOpenAIChatCompletionsSidecarCarriers, verifyOpenAIChatCompletionsTurnDigest } from './as-source/round-trip.ts';
import { openaiChatCompletionsFromIR } from './as-source/sse-to.ts';
import type { SourceProtocol } from '../composition.ts';
import type { OpenAIChatCompletionsPayloadEx, OpenAIChatCompletionsStreamEvent } from '@floway-dev/protocols/openai-chat-completions';

/**
 * Chat Completions read as the side a request comes from.
 *
 * A Chat assistant turn holds exactly one message, so the structure a sidecar
 * describes is that message.
 */
export const openaiChatCompletionsSourceProtocol: SourceProtocol<
  'openaiChatCompletions', OpenAIChatCompletionsPayloadEx, OpenAIChatCompletionsStreamEvent, OpenAIChatCompletionsExtra
> = {
  name: 'openaiChatCompletions',
  open: openaiChatCompletionsOpen,
  roundTrip: {
    inspect: findOpenAIChatCompletionsSidecarCarriers,
    verify: verifyOpenAIChatCompletionsTurnDigest,
    collectCandidates: collectOpenAIChatCompletionsReplayContents,
  },
  writeError: openaiChatCompletionsErrorWriter,
  writeStream: (layout, records, writer) => openaiChatCompletionsFromIR(records, {
    continuousUsageStats: layout.extra.continuousUsageStats,
    roundTrip: writer,
  }),
};
