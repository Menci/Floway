import { openaiResponsesConversationFromIR, openaiResponsesHeaderFromIR } from './input-from.ts';
import { segmentIRInput, type IRInputResolvedTurn } from '../../../ir/input/segments.ts';
import type { IRInputAddressedTurn, IRInputRequest, IRInputTurn } from '../../../ir/input/types.ts';
import type { CanonicalOpenAIResponsesInputItem, CanonicalOpenAIResponsesPayload } from '@floway-dev/protocols/openai-responses';

/**
 * Writes a segmented conversation as one Responses payload.
 *
 * A conversation splits at the assistant turns a sidecar already resolved:
 * those are native Responses items, so they are placed verbatim while every
 * other segment is written from the IR. The request-wide fields are one answer
 * for the whole conversation, so they are computed once beside it.
 *
 * This wire states the prompt slot as one string, which only a conversation's
 * first segment may fill.
 */
export const openaiResponsesPayloadFromSegments = <Restored extends readonly CanonicalOpenAIResponsesInputItem[]>(
  request: IRInputRequest,
  pieces: readonly (IRInputTurn | IRInputResolvedTurn<Restored>)[],
  resolvedInput: (turn: Restored) => readonly CanonicalOpenAIResponsesInputItem[],
): CanonicalOpenAIResponsesPayload => {
  const input: CanonicalOpenAIResponsesInputItem[] = [];
  // The prompt slot is stated once for the conversation, and segmentation is
  // what says which segment may state it.
  let instructions: string | undefined;
  for (const piece of segmentIRInput(pieces)) {
    if (piece.kind === 'resolved') { input.push(...resolvedInput(piece.turn)); continue; }
    const segment = openaiResponsesConversationFromIR(piece.turns as readonly IRInputAddressedTurn[], piece.leading);
    if (segment.instructions != null) instructions ??= segment.instructions;
    input.push(...segment.input);
  }

  // The request-level fields are one answer for the whole conversation, so they
  // are computed once rather than per segment.
  return {
    ...openaiResponsesHeaderFromIR(request),
    input,
    ...(instructions === undefined ? {} : { instructions }),
  };
};
