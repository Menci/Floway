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

const appendMergedContent = (
  target: GeminiGenerateContentContent[],
  content: GeminiGenerateContentContent,
): void => {
  const role = content.role === 'user' ? 'user' : content.role === 'model' ? 'model' : undefined;
  if (role !== undefined && target.at(-1)?.role === role) {
    appendContentParts(target, role, content.parts ?? []);
    return;
  }
  target.push(content);
};

export const geminiGenerateContentPayloadFromSegments = (
  request: IRInputRequestHeader,
  turns: readonly (IRInputTurnWithCallIds | RestoredAssistantTurn<GeminiGenerateContentInputAssistantTurn>)[],
  matchedToolResults: GeminiGenerateContentToolResultLookup,
): GeminiGenerateContentRequest => {
  const systemParts: GeminiGenerateContentPart[] = [];
  const contents: GeminiGenerateContentContent[] = [];
  const syntheticFunctionCalls = new WeakSet<GeminiGenerateContentPart>();

  for (const piece of segmentTurns(turns)) {
    if (piece.kind === 'restored') {
      for (const entry of piece.turn) {
        appendMergedContent(contents, klona(entry));
      }
      continue;
    }
    const segment = geminiGenerateContentConversationFromIR(piece.turns, piece.leading, matchedToolResults, syntheticFunctionCalls);
    systemParts.push(...segment.systemParts);
    for (const content of segment.contents) appendMergedContent(contents, content);
  }

  applySyntheticThoughtSignatures(contents, syntheticFunctionCalls);

  return {
    ...geminiGenerateContentHeaderFromIR(request),
    ...(systemParts.length === 0 ? {} : { systemInstruction: { parts: systemParts } }),
    contents,
  };
};
