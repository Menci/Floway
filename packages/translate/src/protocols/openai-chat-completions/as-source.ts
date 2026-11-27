import { writeOpenAIChatCompletionsError } from './as-source/error-body.ts';
import { writeOpenAIChatCompletionsEvents } from './as-source/events.ts';
import { readOpenAIChatCompletionsRequest } from './as-source/input-to.ts';
import { collectOpenAIChatCompletionsCallIds, collectOpenAIChatCompletionsReplayContents, findOpenAIChatCompletionsSidecarOccurrences, verifyOpenAIChatCompletionsTurnDigest } from './as-source/round-trip.ts';
import type { SourceProtocol } from '../../composition/index.ts';
import type { OpenAIChatCompletionsPayloadEx, OpenAIChatCompletionsStreamEvent } from '@floway-dev/protocols/openai-chat-completions';

/** Chat sidecars authenticate one native assistant message. */
export const openaiChatCompletionsSourceProtocol: SourceProtocol<
  'openaiChatCompletions', OpenAIChatCompletionsPayloadEx, OpenAIChatCompletionsStreamEvent
> = {
  name: 'openaiChatCompletions',
  read: readOpenAIChatCompletionsRequest,
  sidecarRecognition: {
    inspect: findOpenAIChatCompletionsSidecarOccurrences,
    verify: verifyOpenAIChatCompletionsTurnDigest,
    collectCandidates: collectOpenAIChatCompletionsReplayContents,
    collectCallIds: collectOpenAIChatCompletionsCallIds,
  },
  writeError: writeOpenAIChatCompletionsError,
  writeEvents: (payload, records, roundTrip) => writeOpenAIChatCompletionsEvents(records, {
    continuousUsageStats: payload.stream_options?.include_usage === true && payload.stream_options?.continuous_usage_stats === true,
    roundTrip,
  }),
};
