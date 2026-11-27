import { klona } from 'klona/json';

import type { GeminiGenerateContentInputAssistantTurn } from './assistant-turn.ts';
import {
  appendContentParts,
  applySyntheticThoughtSignatures,
  geminiGenerateContentConversationFromIR,
  geminiGenerateContentHeaderFromIR,
  type GeminiGenerateContentToolResultLookup,
} from './input-from.ts';
import type { RestoredAssistantTurn } from '../../../composition/reading.ts';
import type { IRInputTurnWithCallIds } from '../../../composition/request/call-ids.ts';
import { segmentTurns } from '../../../composition/request/segments.ts';
import type { IRInputRequestHeader } from '../../../ir/input/types.ts';
import type {
  GeminiGenerateContentContent,
  GeminiGenerateContentPart,
  GeminiGenerateContentRequest,
} from '@floway-dev/protocols/gemini-generate-content';

export const geminiGenerateContentPayloadFromSegments = (
  request: IRInputRequestHeader,
  turns: readonly (IRInputTurnWithCallIds | RestoredAssistantTurn<GeminiGenerateContentInputAssistantTurn>)[],
  matchedToolResults: GeminiGenerateContentToolResultLookup,
): GeminiGenerateContentRequest => {
  const systemParts: GeminiGenerateContentPart[] = [];
  const contents: (GeminiGenerateContentContent & { role: 'user' | 'model'; parts: GeminiGenerateContentPart[] })[] = [];
  const syntheticFunctionCalls = new WeakSet<GeminiGenerateContentPart>();

  for (const piece of segmentTurns(turns)) {
    if (piece.kind === 'restored') {
      for (const entry of piece.turn) {
        const parts = entry.parts ?? [];
        if (parts.length > 0) {
          appendContentParts(contents, 'model', klona(parts));
        } else if (contents.at(-1)?.role !== 'model') {
          // A restored turn with no parts (e.g. promptFeedback or SAFETY) still needs a
          // non-empty part so Gemini accepts the turn boundary without merging surrounding user turns.
          appendContentParts(contents, 'model', [{ text: '' }]);
        }
      }
      continue;
    }
    const segment = geminiGenerateContentConversationFromIR(
      piece.turns,
      piece.leading,
      matchedToolResults,
      syntheticFunctionCalls,
      contents.at(-1)?.role,
    );
    systemParts.push(...segment.systemParts);
    for (const content of segment.contents) appendContentParts(contents, content.role, content.parts);
  }

  applySyntheticThoughtSignatures(contents, syntheticFunctionCalls);

  return {
    ...geminiGenerateContentHeaderFromIR(request),
    ...(systemParts.length === 0 ? {} : { systemInstruction: { parts: systemParts } }),
    contents,
  };
};
