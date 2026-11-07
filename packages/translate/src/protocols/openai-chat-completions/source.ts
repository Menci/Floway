import type { OpenAIChatCompletionsConversationTurn } from './as-source/conversation-turns.ts';
import type { IRRecord } from '../../ir/output/stream.ts';
import type { RoundTripWriter } from '../../round-trip/stream.ts';
import type { SourceProtocol, SourceReading } from '../composition.ts';
import { openaiChatCompletionsErrorWriter } from './as-source/error-body.ts';
import { openaiChatCompletionsDropsReasoning, openaiChatCompletionsSource, type OpenAIChatCompletionsSource } from './as-source/input-to.ts';
import { collectOpenAIChatCompletionsReplayContents, findOpenAIChatCompletionsSidecarCarriers, verifyOpenAIChatCompletionsTurnDigest, type OpenAIChatCompletionsAssistantTurn } from './as-source/round-trip.ts';
import { openaiChatCompletionsFromIR } from './as-source/sse-to.ts';
import type { OpenAIChatCompletionsPayloadEx, OpenAIChatCompletionsStreamEvent, OpenAIChatCompletionsStreamOptionsEx } from '@floway-dev/protocols/openai-chat-completions';

/**
 * Chat Completions read as the side a request comes from.
 *
 * A Chat assistant turn holds exactly one message, so the assistant part a
 * sidecar describes is that message rather than the run that carries it.
 */
export const openaiChatCompletionsSourceProtocol: SourceProtocol<
  'openaiChatCompletions', OpenAIChatCompletionsPayloadEx, OpenAIChatCompletionsConversationTurn, OpenAIChatCompletionsAssistantTurn, OpenAIChatCompletionsStreamEvent
> = {
  name: 'openaiChatCompletions',
  read: (payload): SourceReading<'openaiChatCompletions', OpenAIChatCompletionsConversationTurn, OpenAIChatCompletionsAssistantTurn, OpenAIChatCompletionsStreamEvent> => {
    const source: OpenAIChatCompletionsSource = openaiChatCompletionsSource(payload);
    // The caller's own stream preferences decide whether a usage report is
    // emitted continuously. They are read here, once, so later mutation of the
    // request cannot change what this trip already decided to emit.
    const streamOptions: OpenAIChatCompletionsStreamOptionsEx | undefined = payload.stream_options == null ? undefined : { ...payload.stream_options };
    return {
      request: source.request,
      input: source,
      assistantTurn: turn => turn.role === 'assistant' ? turn.items[0] : undefined,
      dropsReasoning: openaiChatCompletionsDropsReasoning,
      roundTrip: {
        inspect: findOpenAIChatCompletionsSidecarCarriers,
        verify: verifyOpenAIChatCompletionsTurnDigest,
        collectCandidates: collectOpenAIChatCompletionsReplayContents,
      },
      output: (records: AsyncIterable<IRRecord>, writer: RoundTripWriter<'openaiChatCompletions'>) =>
        openaiChatCompletionsFromIR(records, {
          continuousUsageStats: streamOptions?.include_usage === true && streamOptions.continuous_usage_stats === true,
          roundTrip: writer,
        }),
    };
  },
  writeError: openaiChatCompletionsErrorWriter,
};
