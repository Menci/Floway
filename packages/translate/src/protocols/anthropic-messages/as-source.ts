import { restateAnthropicMessagesError } from './as-source/error-body.ts';
import { anthropicMessagesRead } from './as-source/input-to.ts';
import { collectAnthropicMessagesReplayContents, findAnthropicMessagesSidecarCarriers, verifyAnthropicMessagesTurnDigest } from './as-source/round-trip.ts';
import { anthropicMessagesFromIR } from './as-source/sse-to.ts';
import type { SourceProtocol } from '../../composition/index.ts';
import type { AnthropicMessagesPayload, AnthropicMessagesStreamEventEx } from '@floway-dev/protocols/anthropic-messages';

/**
 * Messages read as the side a request comes from.
 *
 * A sidecar on a Messages assistant turn rides in a `redacted_thinking` block
 * inside the message, so the structure it is computed over is the run of
 * assistant messages the conversation stated.
 */
export const anthropicMessagesSourceProtocol: SourceProtocol<
  'anthropicMessages', AnthropicMessagesPayload, AnthropicMessagesStreamEventEx
> = {
  name: 'anthropicMessages',
  read: anthropicMessagesRead,
  sidecarRecognition: {
    inspect: findAnthropicMessagesSidecarCarriers,
    verify: verifyAnthropicMessagesTurnDigest,
    collectCandidates: collectAnthropicMessagesReplayContents,
  },
  restateUpstreamError: restateAnthropicMessagesError,
  // Stating a Messages stream needs nothing the request produced.
  writeStream: (_payload, records, roundTrip) => anthropicMessagesFromIR(records, { roundTrip }),
};
