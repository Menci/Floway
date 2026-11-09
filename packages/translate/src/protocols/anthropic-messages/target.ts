import type { IRInputResolvedTurn } from '../../ir/input/segments.ts';
import { irInputToolsForChoice } from '../../ir/input/select-tools.ts';
import type { IRInputRequest, IRInputTurn } from '../../ir/input/types.ts';
import type { AssistantTurnFor } from '../../round-trip/assistant-turn.ts';
import { assignCallIds, type PendingCall } from '../../shared/call-ids.ts';
import { flattenRequestNames } from '../../shared/flatten-request.ts';
import type { TranslateContext } from '../../types.ts';
import type { TargetProtocol } from '../composition.ts';
import { anthropicMessagesPayloadFromSegments } from './as-target/segmented-request.ts';
import { irFromAnthropicMessages } from './as-target/sse-from.ts';
import type { AnthropicMessagesMessage, AnthropicMessagesPayload, AnthropicMessagesStreamEventEx } from '@floway-dev/protocols/anthropic-messages';

/**
 * The names this target wrote as functions because it cannot state a freeform
 * declaration directly.
 *
 * Reading the stream back has to recognise those calls as freeform, and the
 * request is the only place that says which declarations were freeform.
 */
const wrappedFreeformNames = (request: IRInputRequest): ReadonlySet<string> =>
  new Set((irInputToolsForChoice(request.tools, request.tool_choice) ?? [])
    .flatMap(tool => tool.type === 'custom' ? [tool.name] : []));

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
  write: (request: IRInputRequest, pieces: readonly (IRInputTurn | IRInputResolvedTurn<AssistantTurnFor<'anthropicMessages'>>)[], ctx: TranslateContext) => {
    // This wire addresses a callable by one bare name, so every grouped
    // declaration and call is stated under the flat spelling it computes.
    const flattened = flattenRequestNames(request, pieces);
    return anthropicMessagesPayloadFromSegments(flattened.request, assignCallIds(flattened.pieces, callsOf), turn => turn, {
      fallbackMaxOutputTokens: ctx.fallbackMaxOutputTokens,
    });
  },
  // A source may declare freeform tools the target could not state natively;
  // reading this stream has to recognise the calls it wrapped them into.
  readStream: (frames, reader, request) => irFromAnthropicMessages(frames, { customToolNames: wrappedFreeformNames(request), roundTrip: reader }),
};
