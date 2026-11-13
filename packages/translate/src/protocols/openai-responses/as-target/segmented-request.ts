import { openaiResponsesConversationFromIR, openaiResponsesHeaderFromIR } from './input-from.ts';
import { type RestoredAssistantTurn } from '../../../composition/reading.ts';
import type { IRInputTurnWithCallIds } from '../../../composition/request/call-ids.ts';
import { segmentTurns } from '../../../composition/request/segments.ts';
import type { IRInputRequestHeader } from '../../../ir/input/types.ts';
import type { CanonicalOpenAIResponsesInputItem, CanonicalOpenAIResponsesPayload } from '@floway-dev/protocols/openai-responses';

/**
 * Preserve restored native Responses turns verbatim and compute request-wide fields once.
 * Only the first conversation segment may supply top-level instructions.
 */
export const openaiResponsesPayloadFromSegments = (
  request: IRInputRequestHeader,
  turns: readonly (IRInputTurnWithCallIds | RestoredAssistantTurn<readonly CanonicalOpenAIResponsesInputItem[]>)[],
): CanonicalOpenAIResponsesPayload => {
  const input: CanonicalOpenAIResponsesInputItem[] = [];
  let instructions: string | undefined;
  for (const piece of segmentTurns(turns)) {
    if (piece.kind === 'restored') { input.push(...piece.turn); continue; }
    const segment = openaiResponsesConversationFromIR(piece.turns, piece.leading);
    if (segment.instructions != null) instructions = segment.instructions;
    input.push(...segment.input);
  }

  return {
    ...openaiResponsesHeaderFromIR(request),
    input,
    ...(instructions === undefined ? {} : { instructions }),
  };
};
