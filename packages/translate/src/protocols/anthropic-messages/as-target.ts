import type { IRInputResolvedTurn } from '../../ir/input/segments.ts';
import type { IRInputRequest, IRInputTurn } from '../../ir/input/types.ts';
import type { AssistantTurnFor } from '../../round-trip/assistant-turn.ts';
import { assignCallIds, type PendingCall } from '../../shared/call-ids.ts';
import { flattenRequestNames } from '../../shared/flatten-request.ts';
import type { TranslateOptions } from '../../types.ts';
import type { TargetProtocol } from '../composition.ts';
import { anthropicMessagesPayloadFromSegments } from './as-target/segmented-request.ts';
import { irFromAnthropicMessages } from './as-target/sse-from.ts';
import type { AnthropicMessagesMessage, AnthropicMessagesPayload, AnthropicMessagesStreamEventEx } from '@floway-dev/protocols/anthropic-messages';

const callsOf = (turn: Extract<AnthropicMessagesMessage, { role: 'assistant' }>): readonly PendingCall[] =>
  Array.isArray(turn.content)
    ? turn.content.flatMap(block => block.type === 'tool_use' || block.type === 'server_tool_use' ? [{ callId: block.id, name: block.name }] : [])
    : [];

/**
 * Messages written as the side a request goes to.
 *
 * A resolved turn arrives here as the assistant message a sidecar described,
 * so the calls it states are the ones its own content blocks name — read here
 * rather than inferred, because only Messages knows where it puts them.
 */
export const anthropicMessagesTargetProtocol: TargetProtocol<
  'anthropicMessages', AnthropicMessagesPayload, AnthropicMessagesStreamEventEx
> = {
  name: 'anthropicMessages',
  write: async (request: IRInputRequest, pieces: readonly (IRInputTurn | IRInputResolvedTurn<AssistantTurnFor<'anthropicMessages'>>)[], options: TranslateOptions) => {
    // This wire addresses a callable by one bare name, so every grouped
    // declaration and call is stated under the flat spelling it computes.
    const flattened = flattenRequestNames(request, pieces);
    return {
      payload: await anthropicMessagesPayloadFromSegments(flattened.request, assignCallIds(flattened.pieces, callsOf), turn => turn, {
        fallbackMaxOutputTokens: options.fallbackMaxOutputTokens,
      }),
      // Both facts come from the same flattening that produced the request, so
      // the reader sees exactly the names the upstream was asked with.
      context: flattened.context,
    };
  },
  readStream: (frames, context, roundTripReader) => irFromAnthropicMessages(frames, { ...context, roundTrip: roundTripReader }),
};
