import { openaiResponsesConversationFromIR, openaiResponsesHeaderFromIR } from './input-from.ts';
import type { IRInputAddressedTurn, IRInputRequestHeader } from '../../../ir/input/types.ts';
import { segmentTurns, type ResolvedTurn } from '../../composition/segments.ts';
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
  request: IRInputRequestHeader,
  turns: readonly (IRInputAddressedTurn | ResolvedTurn<Restored>)[],
  resolvedInput: (turn: Restored) => readonly CanonicalOpenAIResponsesInputItem[],
): CanonicalOpenAIResponsesPayload => {
  const input: CanonicalOpenAIResponsesInputItem[] = [];
  // The prompt slot is stated once for the conversation, and segmentation is
  // what says which segment may state it.
  let instructions: string | undefined;
  for (const piece of segmentTurns(turns)) {
    if (piece.kind === 'resolved') { input.push(...resolvedInput(piece.turn)); continue; }
    const segment = openaiResponsesConversationFromIR(piece.turns, piece.leading);
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
