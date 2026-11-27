import type { GeminiGenerateContentInputAssistantTurn } from './assistant-turn.ts';
import {
  createGeminiGenerateContentConversationWriter,
  geminiGenerateContentHeaderFromIR,
  type GeminiGenerateContentToolResultLookup,
} from './input-from.ts';
import type { RestoredAssistantTurn } from '../../../composition/reading.ts';
import type { IRInputTurnWithCallIds } from '../../../composition/request/call-ids.ts';
import { segmentTurns } from '../../../composition/request/segments.ts';
import type { IRInputRequestHeader } from '../../../ir/input/types.ts';
import type { GeminiGenerateContentRequest } from '@floway-dev/protocols/gemini-generate-content';

export const geminiGenerateContentPayloadFromSegments = (
  request: IRInputRequestHeader,
  turns: readonly (IRInputTurnWithCallIds | RestoredAssistantTurn<GeminiGenerateContentInputAssistantTurn>)[],
  matchedToolResults: GeminiGenerateContentToolResultLookup,
): GeminiGenerateContentRequest => {
  const writer = createGeminiGenerateContentConversationWriter(matchedToolResults);

  for (const piece of segmentTurns(turns)) {
    if (piece.kind === 'restored') writer.appendRestoredTurn(piece.turn);
    else writer.appendIRSegment(piece.turns, piece.leading);
  }

  const { systemParts, contents } = writer.finish();
  return {
    ...geminiGenerateContentHeaderFromIR(request),
    ...(systemParts.length === 0 ? {} : { systemInstruction: { parts: systemParts } }),
    contents,
  };
};
