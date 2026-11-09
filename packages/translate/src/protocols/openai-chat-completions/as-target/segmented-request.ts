import { openaiChatCompletionsFromIR, openaiChatCompletionsHeaderFromIR } from './input-from.ts';
import { segmentIRInput, type IRInputResolvedTurn } from '../../../ir/input/segments.ts';
import type { IRInputAddressedTurn, IRInputRequest } from '../../../ir/input/types.ts';
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
  pieces: readonly (IRInputAddressedTurn | IRInputResolvedTurn<Restored>)[],
  resolvedMessage: (turn: Restored) => OpenAIChatCompletionsMessage,
): OpenAIChatCompletionsPayload => {
  const messages: OpenAIChatCompletionsMessage[] = [];
  for (const piece of segmentIRInput(pieces)) {
    if (piece.kind === 'resolved') { messages.push(resolvedMessage(piece.turn)); continue; }
    messages.push(...openaiChatCompletionsFromIR(piece.turns));
  }
  // The request-level fields are one answer for the whole conversation, so they
  // are computed once rather than per segment.
  return { ...openaiChatCompletionsHeaderFromIR(request), messages };
};
