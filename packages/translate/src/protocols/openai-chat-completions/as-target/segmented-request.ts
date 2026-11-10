import { openaiChatCompletionsFromIR, openaiChatCompletionsHeaderFromIR } from './input-from.ts';
import type { IRInputAddressedTurn, IRInputRequest } from '../../../ir/input/types.ts';
import { segmentTurns, type ResolvedTurn } from '../../composition/segments.ts';
import type { OpenAIChatCompletionsMessage, OpenAIChatCompletionsPayload } from '@floway-dev/protocols/openai-chat-completions';

/**
 * Writes a segmented conversation as one Chat Completions payload.
 *
 * A conversation splits at the assistant turns a sidecar already resolved:
 * those are native Chat messages, so they are placed verbatim while every other
 * segment is written from the IR. The request-wide fields are one answer for
 * the whole conversation, so they are computed once beside it.
 *
 * Chat states no top-level prompt slot, so a leading prompt stays an ordinary
 * message wherever the caller put it.
 */
export const openaiChatCompletionsPayloadFromSegments = <Restored extends OpenAIChatCompletionsMessage>(
  request: IRInputRequest,
  pieces: readonly (IRInputAddressedTurn | ResolvedTurn<Restored>)[],
  resolvedMessage: (turn: Restored) => OpenAIChatCompletionsMessage,
  // Results that answer a legacy `function_call` are written as the legacy
  // `function` message, which is the only one this wire pairs with that field.
  legacyCalls: ReadonlyMap<string, string>,
): OpenAIChatCompletionsPayload => {
  const messages: OpenAIChatCompletionsMessage[] = [];
  for (const piece of segmentTurns(pieces)) {
    if (piece.kind === 'resolved') { messages.push(resolvedMessage(piece.turn)); continue; }
    messages.push(...openaiChatCompletionsFromIR(piece.turns, legacyCalls));
  }
  // The request-level fields are one answer for the whole conversation, so they
  // are computed once rather than per segment.
  return { ...openaiChatCompletionsHeaderFromIR(request), messages };
};
