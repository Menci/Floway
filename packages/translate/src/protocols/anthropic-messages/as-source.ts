import { restateAnthropicMessagesError } from './as-source/error-body.ts';
import { writeAnthropicMessagesEvents } from './as-source/events.ts';
import { readAnthropicMessagesRequest } from './as-source/input-to.ts';
import { collectAnthropicMessagesReplayContents, findAnthropicMessagesSidecarOccurrences, verifyAnthropicMessagesTurnDigest } from './as-source/round-trip.ts';
import type { SourceProtocol } from '../../composition/index.ts';
import type { AnthropicMessagesPayload, AnthropicMessagesStreamEventEx } from '@floway-dev/protocols/anthropic-messages';

/** Messages sidecars ride in redacted_thinking blocks and authenticate the native run of assistant messages. */
export const anthropicMessagesSourceProtocol: SourceProtocol<
  'anthropicMessages', AnthropicMessagesPayload, AnthropicMessagesStreamEventEx
> = {
  name: 'anthropicMessages',
  read: readAnthropicMessagesRequest,
  sidecarRecognition: {
    inspect: findAnthropicMessagesSidecarOccurrences,
    verify: verifyAnthropicMessagesTurnDigest,
    collectCandidates: collectAnthropicMessagesReplayContents,
  },
  error: restateAnthropicMessagesError,
  writeEvents: (_payload, records, roundTrip) => writeAnthropicMessagesEvents(records, { roundTrip }),
};
