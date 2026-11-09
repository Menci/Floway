import { openaiChatCompletionsErrorWriter } from './as-source/error-body.ts';
import { openaiChatCompletionsDropsReasoning, openaiChatCompletionsOpen } from './as-source/input-to.ts';
import { collectOpenAIChatCompletionsReplayContents, findOpenAIChatCompletionsSidecarCarriers, verifyOpenAIChatCompletionsTurnDigest } from './as-source/round-trip.ts';
import { openaiChatCompletionsFromIR } from './as-source/sse-to.ts';
import type { SourceProtocol } from '../composition.ts';
import type { OpenAIChatCompletionsPayloadEx, OpenAIChatCompletionsStreamEvent, OpenAIChatCompletionsStreamOptionsEx } from '@floway-dev/protocols/openai-chat-completions';

/**
 * Whether the caller asked for a usage report on every chunk.
 *
 * Read once while opening, because the caller may keep mutating its own request
 * and this trip has already decided what to emit.
 */
interface OpenAIChatCompletionsExtra {
  readonly continuousUsageStats: boolean;
}

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
  open: payload => {
    const layout = openaiChatCompletionsOpen(payload);
    const streamOptions: OpenAIChatCompletionsStreamOptionsEx | undefined = payload.stream_options == null
      ? undefined
      : { ...payload.stream_options };
    const extra: OpenAIChatCompletionsExtra = {
      continuousUsageStats: streamOptions?.include_usage === true && streamOptions.continuous_usage_stats === true,
    };
    return { ...layout, extra };
  },
  dropsReasoning: openaiChatCompletionsDropsReasoning,
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
