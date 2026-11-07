import { partitionAnthropicMessagesTurns, type AnthropicMessagesConversationTurn } from './as-source/conversation-turns.ts';
import { anthropicMessagesErrorWriter } from './as-source/error-body.ts';
import type { IRInputRequest } from '../../ir/input/types.ts';
import type { IRRecord } from '../../ir/output/stream.ts';
import type { RoundTripWriter } from '../../round-trip/stream.ts';
import type { SourceProtocol, SourceReading } from '../composition.ts';
import { anthropicMessagesDropsReasoning, anthropicMessagesSource, type AnthropicMessagesSource } from './as-source/input-to.ts';
import { collectAnthropicMessagesReplayContents, findAnthropicMessagesSidecarCarriers, verifyAnthropicMessagesTurnDigest, type AnthropicMessagesAssistantTurn } from './as-source/round-trip.ts';
import { anthropicMessagesFromIR } from './as-source/sse-to.ts';
import type { AnthropicMessagesPayload, AnthropicMessagesStreamEventEx } from '@floway-dev/protocols/anthropic-messages';

/**
 * Messages read as the side a request comes from.
 *
 * The assistant part of a conversation turn is the unit a native turn
 * round-trips as: Messages states an assistant message, or a run of them, and
 * that run is what a sidecar describes.
 */
export const anthropicMessagesSourceProtocol: SourceProtocol<
  'anthropicMessages', AnthropicMessagesPayload, AnthropicMessagesConversationTurn, AnthropicMessagesAssistantTurn, AnthropicMessagesStreamEventEx
> = {
  name: 'anthropicMessages',
  read: (payload): SourceReading<'anthropicMessages', AnthropicMessagesConversationTurn, AnthropicMessagesAssistantTurn, AnthropicMessagesStreamEventEx> => {
    const source: AnthropicMessagesSource = anthropicMessagesSource(payload);
    return {
      request: source.request,
      input: source,
      assistantTurn: turn => turn.role === 'assistant' ? turn.items : undefined,
      dropsReasoning: anthropicMessagesDropsReasoning,
      roundTrip: {
        inspect: findAnthropicMessagesSidecarCarriers,
        verify: verifyAnthropicMessagesTurnDigest,
        collectCandidates: collectAnthropicMessagesReplayContents,
      },
      output: (records: AsyncIterable<IRRecord>, writer: RoundTripWriter<'anthropicMessages'>, _request: IRInputRequest) =>
        anthropicMessagesFromIR(records, { roundTrip: writer }),
    };
  },
  writeError: anthropicMessagesErrorWriter,
};

export { partitionAnthropicMessagesTurns };
