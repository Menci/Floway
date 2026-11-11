import { restateOpenAIChatCompletionsError } from './as-source/error-body.ts';
import { writeOpenAIChatCompletionsEvents } from './as-source/events.ts';
import { continuousUsageOf, readOpenAIChatCompletionsRequest } from './as-source/input-to.ts';
import { collectOpenAIChatCompletionsReplayContents, findOpenAIChatCompletionsSidecarOccurrences, verifyOpenAIChatCompletionsTurnDigest } from './as-source/round-trip.ts';
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
  },
  error: restateOpenAIChatCompletionsError,
  writeEvents: (payload, records, roundTrip) => writeOpenAIChatCompletionsEvents(records, {
    continuousUsageStats: continuousUsageOf(payload),
    roundTrip,
  }),
};
