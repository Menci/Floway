import { readAnthropicMessagesEvents } from './as-target/events.ts';
import { anthropicMessagesPayloadFromSegments } from './as-target/segmented-request.ts';
import type { TargetProtocol } from '../../composition/index.ts';
import type { RestoredAssistantTurn } from '../../composition/reading.ts';
import { assignCallIds, type PendingCall } from '../../composition/request/call-ids.ts';
import { allocateToolNames, type ToolNameContext } from '../../composition/request/tool-names.ts';
import type { IRInputRequestHeader, IRInputTurn } from '../../ir/input/types.ts';
import type { InputAssistantTurnFor } from '../../round-trip/input-assistant-turn.ts';
import type { TranslateOptions } from '../../types.ts';
import type { AnthropicMessagesMessage, AnthropicMessagesPayload, AnthropicMessagesStreamEventEx } from '@floway-dev/protocols/anthropic-messages';

const callsOf = (turn: Extract<AnthropicMessagesMessage, { role: 'assistant' }>): readonly PendingCall[] =>
  Array.isArray(turn.content)
    ? turn.content.flatMap(block => block.type === 'tool_use' || block.type === 'server_tool_use' ? [{ callId: block.id, name: block.name }] : [])
    : [];

/** Read pending call IDs from restored Messages tool_use blocks before writing later results. */
export const anthropicMessagesTargetProtocol: TargetProtocol<
  'anthropicMessages', AnthropicMessagesPayload, AnthropicMessagesStreamEventEx, ToolNameContext
> = {
  name: 'anthropicMessages',
  write: (request: IRInputRequestHeader, turns: readonly (IRInputTurn | RestoredAssistantTurn<InputAssistantTurnFor<'anthropicMessages'>>)[], options: TranslateOptions) => {
    // This wire addresses a callable by one bare name, so every grouped
    // declaration and call is stated under the flat spelling it computes.
    const assigned = assignCallIds(turns, callsOf);
    const flattened = allocateToolNames(request, assigned);
    return {
      payload: anthropicMessagesPayloadFromSegments(flattened.request, flattened.turns, {
        fallbackMaxOutputTokens: options.fallbackMaxOutputTokens,
      }),
      // Both facts come from the same flattening that produced the request, so
      // the reader sees exactly the names the upstream was asked with.
      context: flattened.context,
    };
  },
  readEvents: (frames, context, roundTripReader) => readAnthropicMessagesEvents(frames, { ...context, roundTrip: roundTripReader }),
};
