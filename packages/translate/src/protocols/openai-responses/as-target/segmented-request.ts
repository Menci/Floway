import { openaiResponsesRequestFromIR } from './input-from.ts';
import { segmentIRInput, type IRInputResolvedTurn } from '../../../ir/input/segments.ts';
import type { IRInputRequest, IRInputTurn } from '../../../ir/input/types.ts';
import type { CanonicalOpenAIResponsesInputItem, CanonicalOpenAIResponsesPayload } from '@floway-dev/protocols/openai-responses';

/**
 * Writes a segmented conversation as one Responses payload.
 *
 * A conversation splits at the assistant turns a sidecar already resolved:
 * those are native Responses items, so they are placed verbatim while every
 * other segment is written from the IR. The request-wide fields come from the
 * first translated segment; later segments contribute only their input items.
 *
 * Responses spells the prompt slot as one string, so a conversation that states
 * a prompt in more than one segment joins those statements the same way a
 * multi-message prompt run does.
 */
export const openaiResponsesPayloadFromSegments = <Restored extends readonly CanonicalOpenAIResponsesInputItem[]>(
  request: IRInputRequest,
  pieces: readonly (IRInputTurn | IRInputResolvedTurn<Restored>)[],
  resolvedInput: (turn: Restored) => readonly CanonicalOpenAIResponsesInputItem[],
): CanonicalOpenAIResponsesPayload => {
  const input: CanonicalOpenAIResponsesInputItem[] = [];
  const instructions: string[] = [];
  let base: CanonicalOpenAIResponsesPayload | undefined;
  for (const piece of segmentIRInput(pieces)) {
    if (piece.kind === 'resolved') { input.push(...resolvedInput(piece.turn)); continue; }
    // Only a conversation's first segment holds the request's leading prompt; a
    // later segment continues an exchange that already started.
    const translated = openaiResponsesRequestFromIR({ ...request, conversation: { turns: piece.turns } }, piece.leading);
    base ??= translated;
    if (translated.instructions != null) instructions.push(translated.instructions);
    input.push(...translated.input);
  }
  base ??= openaiResponsesRequestFromIR({ ...request, conversation: { turns: [] } });

  return {
    ...base,
    input,
    ...(instructions.length === 0 ? {} : { instructions: instructions.join('\n\n') }),
  };
};
