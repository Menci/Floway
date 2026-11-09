import { anthropicMessagesErrorWriter } from './as-source/error-body.ts';
import { anthropicMessagesOpen } from './as-source/input-to.ts';
import { anthropicMessagesFromIR } from './as-source/sse-to.ts';
import { collectAnthropicMessagesReplayContents, findAnthropicMessagesSidecarCarriers, verifyAnthropicMessagesTurnDigest } from './as-source/round-trip.ts';
import type { SourceProtocol } from '../composition.ts';
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
  open: anthropicMessagesOpen,
  roundTrip: {
    inspect: findAnthropicMessagesSidecarCarriers,
    verify: verifyAnthropicMessagesTurnDigest,
    collectCandidates: collectAnthropicMessagesReplayContents,
  },
  writeError: anthropicMessagesErrorWriter,
  // Stating a Messages stream needs nothing the request produced.
  writeStream: (_layout, records, writer) => anthropicMessagesFromIR(records, { roundTrip: writer }),
};
