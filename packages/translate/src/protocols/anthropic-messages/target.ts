import type { IRInputResolvedTurn } from '../../ir/input/segments.ts';
import { irInputCustomToolNames } from '../../ir/input/select-tools.ts';
import type { IRInputRequest, IRInputTurn } from '../../ir/input/types.ts';
import type { AssistantTurnFor } from '../../round-trip/assistant-turn.ts';
import type { TranslateContext } from '../../types.ts';
import type { TargetProtocol } from '../composition.ts';
import { anthropicMessagesPayloadFromSegments } from './as-target/segmented-request.ts';
import { irFromAnthropicMessages } from './as-target/sse-from.ts';
import type { AnthropicMessagesMessage, AnthropicMessagesPayload, AnthropicMessagesStreamEventEx } from '@floway-dev/protocols/anthropic-messages';

const callsOf = (turn: Extract<AnthropicMessagesMessage, { role: 'assistant' }>): readonly { callId: string; name: string }[] =>
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
  pendingCallIds: turn => callsOf(turn),
  write: (request: IRInputRequest, pieces: readonly (IRInputTurn | IRInputResolvedTurn<AssistantTurnFor<'anthropicMessages'>>)[], ctx: TranslateContext) =>
    anthropicMessagesPayloadFromSegments(request, pieces, turn => turn, {
      fallbackMaxOutputTokens: ctx.fallbackMaxOutputTokens,
    }),
  // A source may declare freeform tools the target could not state natively;
  // reading this stream has to recognise the calls it wrapped them into.
  readStream: (frames, reader, _request, customToolNames) => irFromAnthropicMessages(frames, { customToolNames, roundTrip: reader }),
};
